# Admin API (Production)

## Auth
- Admin routes are protected behind OIDC via oauth2-proxy.
- For local dev, a **Bearer** fallback `changeme-admin-token` remains available.

## Endpoints
- `POST /catalog/admin/tokens` create token
- `PATCH /catalog/admin/tokens/:id` update price/inventory/enabled
- `GET /catalog/public/custom-tokens` list public custom tokens

## Sell flow
- `POST /sell-orders` { tokenId, amountCrypto, method: CARD|BANK, destAddress } (Idempotency-Key supported)
- `POST /sell-orders/:id/confirm` finalize (webhook will do this in card flow)
- `POST /sell-orders/:id/cancel` cancel reservation

## Payments webhooks
- `POST /webhook/payments` (Stripe-like). Verify signatures in prod.
