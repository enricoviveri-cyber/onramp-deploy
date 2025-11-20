# Onramp — Transak-like (Production Bundle)

This bundle contains a production-oriented implementation with:
- **OIDC/MFA** (oauth2-proxy) for admin routes
- **WAF/allow-list** annotations examples
- **PostgreSQL** catalog (transactions, row locks) + idempotency keys
- **Wallet validation via SDKs** (ethers, bitcoinjs-lib, @solana/web3.js)
- **Payments**: Stripe-style 3DS flow (webhooks), Bank settle simulation
- **Kong** gateway, Helm charts and Docker Compose (dev & prod)

## Quick start (dev)
```bash
docker compose -f deploy/compose/docker-compose.yml up --build -d
# coverage
curl -s "http://localhost:8000/cryptocoverage/api/v1/public/crypto-currencies?search=usdc" | jq .
# admin create token (file backend by default)
curl -s -X POST http://localhost:8000/catalog/admin/tokens \\
 -H "Authorization: Bearer changeme-admin-token" -H "Content-Type: application/json" \\
 -d '{"name":"My USDC","symbol":"USDC","network":"ethereum","priceFiat":1.10,"fiatCurrency":"EUR","inventory":1000,"decimals":6}' | jq .
```

## Quick start (prod-like on localhost)
```bash
# start Postgres + full stack
docker compose -f deploy/compose/docker-compose.prod.yml up --build -d
# migrate
docker compose -f deploy/compose/docker-compose.prod.yml exec catalog npm run migrate
# switch backend to postgres (env CATALOG_BACKEND=postgres already set in prod compose)
```

See `docs/PRODUCTION.md` for WAF/OIDC/Helm and `docs/ADMIN.md` for admin APIs.
