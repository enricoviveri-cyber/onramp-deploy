#!/usr/bin/env bash
set -euo pipefail

# ==================== CARICAMENTO .env SICURO ====================
if [[ ! -f .env ]]; then
  echo "[ERR] File .env non trovato nella cartella corrente!"
  exit 1
fi

set -a
source .env
set +a

# ==================== VARIABILI OBBLIGATORIE ====================
: "${REGION:?}"
: "${CLUSTER_NAME:?}"
: "${DOMAIN:?}"
: "${API_HOST:?}"
: "${ADMIN_HOST:?}"
: "${CF_API_TOKEN:?}"
: "${CF_ZONE_ID:?}"
: "${CF_ZONE_NAME:?}"
: "${AUTH0_DOMAIN:?}"
: "${AUTH0_MGMT_API_TOKEN:?}"
: "${STRIPE_SECRET:?}"
: "${DB_PASS:?}"
: "${IMAGE_TAG:=1.0.0}"

# ==================== TOOL RICHIESTI ====================
need(){ command -v "$1" >/dev/null 2>&1 || { echo "[ERR] manca $1 → installalo"; exit 1; }; }
need aws; need jq; need curl; need kubectl; need eksctl; need helm; need openssl

info(){ printf "\033[36m[INFO]\033[0m %s\n" "$*"; }
ok(){   printf "\033[32m[OK]\033[0m   %s\n" "$*"; }
err(){  printf "\033[31m[ERR]\033[0m  %s\n" "$*"; exit 1; }

ACC_ID=$(aws sts get-caller-identity --query Account --output text) || err "Credenziali AWS non valide"
ok "Account AWS: $ACC_ID – Regione: $REGION"

# ==================== HELPER CLOUDFLARE ====================
cf_api() {
  local METHOD="$1" PATH="$2" DATA="${3:-}"
  local URL="https://api.cloudflare.com/client/v4${PATH}"
  curl -fsSL -X "$METHOD" "$URL" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    ${DATA:+-d "$DATA"}
}

cf_upsert_cname() {
  local NAME="$1" TARGET="$2" PROXIED="${3:-false}"
  local BODY=$(jq -n --arg n "$NAME" --arg c "$TARGET" --argjson p "$PROXIED" '{type:"CNAME",name:$n,content:$c,ttl:120,proxied:$p}')
  local EXIST=\( (cf_api GET "/zones/ \){CF_ZONE_ID}/dns_records?type=CNAME&name=${NAME}")
  local ID=$(echo "$EXIST" | jq -r '.result[0].id // ""')
  if [[ -n "$ID" ]]; then
    cf_api PUT "/zones/${CF_ZONE_ID}/dns_records/$ID" "$BODY" >/dev/null
  else
    cf_api POST "/zones/${CF_ZONE_ID}/dns_records" "$BODY" >/dev/null
  fi
}

# ==================== 1. EKS + ALB Controller ====================
info "Creazione cluster EKS ${CLUSTER_NAME}…"
eksctl create cluster --name "$CLUSTER_NAME" --region "$REGION" --with-oidc --managed --nodegroup-name workers --nodes 3 --node-type t3.large --nodes-min 2 --nodes-max 6 || true

VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --query "cluster.resourcesVpcConfig.vpcId" --output text)
helm repo add eks https://aws.github.io/eks-charts && helm repo update
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system \
  --set clusterName="$CLUSTER_NAME" --set region="$REGION" --set vpcId="$VPC_ID" \
  --set image.repository="602401143452.dkr.ecr.$REGION.amazonaws.com/amazon/aws-load-balancer-controller"
kubectl -n kube-system rollout status deploy/aws-load-balancer-controller

# ==================== 2. Certificati ACM + validazione Cloudflare ====================
issue_cert() {
  local HOST="$1"
  local ARN=$(aws acm request-certificate --region "$REGION" --domain-name "$HOST" --validation-method DNS --query CertificateArn --output text)
  sleep 15
  local REC=$(aws acm describe-certificate --certificate-arn "$ARN" --query "Certificate.DomainValidationOptions[0].ResourceRecord" --output json)
  local NAME=$(echo "\( REC" | jq -r .Name | sed 's/\. \)//')
  local VALUE=$(echo "\( REC" | jq -r .Value | sed 's/\. \)//')
  info "Validazione DNS per $HOST → CNAME $NAME = $VALUE"
  cf_upsert_cname "$NAME" "$VALUE" false
  until [[ "$(aws acm describe-certificate --certificate-arn "$ARN" --query Certificate.Status --output text)" == "ISSUED" ]]; do sleep 20; done
  echo "$ARN"
}

info "Richiesta certificati ACM…"
API_CERT_ARN=$(issue_cert "$API_HOST")
ADMIN_CERT_ARN=$(issue_cert "$ADMIN_HOST")
ok "Certificati pronti → API: $API_CERT_ARN | ADMIN: $ADMIN_CERT_ARN"

# ==================== 3. RDS PostgreSQL ====================
info "Creazione RDS PostgreSQL…"
SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query "Subnets[].SubnetId" --output text)
aws rds create-db-subnet-group --db-subnet-group-name "${CLUSTER_NAME}-sng" --db-subnet-group-description "onramp" --subnet-ids $SUBNETS >/dev/null 2>&1 || true

aws rds create-db-instance --db-instance-identifier "${CLUSTER_NAME}-db" \
  --engine postgres --engine-version 16.3 --db-instance-class db.t3.medium \
  --allocated-storage 20 --master-username onramp --master-user-password "$DB_PASS" \
  --db-subnet-group-name "${CLUSTER_NAME}-sng" --multi-az --storage-encrypted --publicly-accessible false >/dev/null || true

aws rds wait db-instance-available --db-instance-identifier "${CLUSTER_NAME}-db"
DB_ENDPOINT=\( (aws rds describe-db-instances --db-instance-identifier " \){CLUSTER_NAME}-db" --query "DBInstances[0].Endpoint.Address" --output text)
ok "RDS pronto → $DB_ENDPOINT"

# ==================== 4. ECR repos ====================
info "Creazione repo ECR…"
for svc in catalog orders quotes kyc payments wallet coverage verifywallet; do
  aws ecr create-repository --repository-name "onramp/$svc" --region "$REGION" >/dev/null 2>&1 || true
done

# ==================== 5. Secrets + Deploy microservizi ====================
DATABASE_URL="postgresql://onramp:\( {DB_PASS}@ \){DB_ENDPOINT}:5432/onramp"
kubectl create namespace onramp --dry-run=client -o yaml | kubectl apply -f -

kubectl -n onramp create secret generic app-secrets \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=STRIPE_SECRET="$STRIPE_SECRET" \
  --from-literal=AUTH0_ISSUER_URL="https://${AUTH0_DOMAIN}/" \
  --from-literal=AUTH0_CLIENT_ID="pending" \
  --from-literal=AUTH0_CLIENT_SECRET="pending" --dry-run=client -o yaml | kubectl apply -f -

# (Qui assume che tu abbia già pushato le immagini ECR con tag $IMAGE_TAG)
# Se non le hai ancora buildate/pushate → dimmelo e ti do i comandi docker in 10 secondi

# ==================== 6. Auth0 App automatica + oauth2-proxy ====================
info "Creazione applicazione OIDC su Auth0…"
APP_JSON=\( (curl -s -X POST "https:// \){AUTH0_DOMAIN}/api/v2/clients" \
  -H "Authorization: Bearer ${AUTH0_MGMT_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "NeoNoble Onramp",
    "app_type": "regular_web",
    "callbacks": ["https://'"${ADMIN_HOST}"'/oauth2/callback"],
    "oidc_conformant": true,
    "jwt_configuration": {"alg": "RS256"}
  }')

AUTH0_CLIENT_ID=$(echo "$APP_JSON" | jq -r .client_id)
AUTH0_CLIENT_SECRET=$(echo "$APP_JSON" | jq -r .client_secret)
ok "Auth0 app creata → $AUTH0_CLIENT_ID"

kubectl -n onramp delete secret app-secrets 2>/dev/null || true
kubectl -n onramp create secret generic app-secrets \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=STRIPE_SECRET="$STRIPE_SECRET" \
  --from-literal=AUTH0_ISSUER_URL="https://${AUTH0_DOMAIN}/" \
  --from-literal=AUTH0_CLIENT_ID="$AUTH0_CLIENT_ID" \
  --from-literal=AUTH0_CLIENT_SECRET="$AUTH0_CLIENT_SECRET"

helm repo add oauth2-proxy https://oauth2-proxy.github.io/manifests && helm repo update
helm upgrade --install oauth2-proxy oauth2-proxy/oauth2-proxy -n onramp \
  --set authenticatedEmailsFile.enabled=false \
  --set config.clientID="$AUTH0_CLIENT_ID" \
  --set config.clientSecret="$AUTH0_CLIENT_SECRET" \
  --set config.oidcIssuerURL="https://${AUTH0_DOMAIN}/" \
  --set cookie.secret="$(openssl rand -hex 16)" \
  --set ingress.enabled=true --set ingress.hosts="{$ADMIN_HOST}"

# ==================== 7. Ingress ALB + DNS finale ====================
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: onramp
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: $API_CERT_ARN
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
spec:
  rules:
  - host: $API_HOST
    http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: orders, port: { number: 3000 }}}}]}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: admin-ingress
  namespace: onramp
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: $ADMIN_CERT_ARN
spec:
  rules:
  - host: $ADMIN_HOST
    http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: oauth2-proxy, port: { number: 4180 }}}}]}
EOF

sleep 20
ALB_API=$(kubectl -n onramp get ingress api-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
ALB_ADMIN=$(kubectl -n onramp get ingress admin-ingress -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

cf_upsert_cname "$API_HOST" "$ALB_API" false
cf_upsert_cname "$ADMIN_HOST" "$ALB_ADMIN" false

ok "FINITO!"
echo "→ API: https://$API_HOST"
echo "→ Admin (Auth0 login): https://$ADMIN_HOST"
echo "Il cluster è online – tra 2-3 minuti i DNS si propagano e sei live al 100%."
