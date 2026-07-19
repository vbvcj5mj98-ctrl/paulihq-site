# Pauli HQ

A Cloudflare-first family website with a public photo landing page and a private portal protected by Cloudflare Access.

## Cloudflare deployment

1. In Cloudflare, open **Workers & Pages** and choose **Create application**.
2. Import this GitHub repository.
3. Use `npm run build` as the build command and `npx wrangler deploy` as the deploy command if Cloudflare does not fill them automatically.
4. Deploy, then add the purchased domain under **Settings > Domains & Routes**.

## Protect the private portal

Do this before placing private information in the portal.

1. Open **Zero Trust > Integrations > Identity providers** and add **One-time PIN**.
2. Open **Zero Trust > Access controls > Applications**.
3. Create a **Self-hosted and private** application.
4. Add the public hostname using your domain and path `/portal/*`.
5. Create an **Allow** policy using the **Emails** selector.
6. Enter exactly the two approved email addresses—one for Carson and one for his wife.
7. Select **One-time PIN** as the login method and save.

Cloudflare will intercept `/portal` before the website loads and email an expiring sign-in code to either approved address. Never commit passwords or secrets to this repository.
