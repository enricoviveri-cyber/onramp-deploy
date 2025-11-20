# Production Notes

## OIDC/MFA
- Use Keycloak/Entra ID. Enforce MFA at IdP level.
- Deploy oauth2-proxy in front of admin routes. See `deploy/helm/oauth2-proxy/values.yaml` and `deploy/helm/ingress-admin.yaml`.

## WAF / Allow-list
- Put Cloudflare/AWS WAF in front. Add allow-list to `/catalog/admin/*` for office/VPN.
- Add rate limit rules for `/orders`, `/sell-orders`, `/webhook/*`.

## Observability & Audit
- All services output JSON logs; ship to Loki/ELK. Enable S3 object lock for audit archive.

## Database
- PostgreSQL with schema in `deploy/db/migrations/001_init.sql`.
- Use `npm run migrate` in `catalog` to apply migrations.
- Idempotency keys used by `orders` for create/confirm endpoints.

## Secrets
- Use Kubernetes secrets + external Secret Store (e.g., AWS Secrets Manager/HashiCorp Vault).
- Never commit real secrets; set via environment variables in Helm values.

## Payments
- Integrate a PSP (Stripe/Adyen). Set webhook signing secret. Use manual capture for card, bank settle via open banking provider.
