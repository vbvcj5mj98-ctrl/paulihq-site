# Pauli HQ

A Cloudflare-first family website with a public photo landing page, two private accounts, and a post-login workspace designed for future AI tools.

## Cloudflare deployment

1. In Cloudflare, open **Workers & Pages** and import this GitHub repository.
2. Use `npm run build` as the build command and `npx wrangler deploy` as the deploy command.
3. Add `paulihq.com` under **Settings > Domains & Routes**.

Cloudflare automatically provisions the `DB` D1 binding declared in `wrangler.jsonc`. Authentication tables are created on first use.

## Set up the two accounts

The approved usernames are `carsonpauli` and `jessipauli`. Passwords are never committed to GitHub.

1. In **Workers & Pages > paulihq-site > Settings > Variables and Secrets**, add an encrypted secret named `SETUP_CODE` with a private value known only to the family.
2. Redeploy the current version if Cloudflare requests it.
3. Visit `https://paulihq.com/setup`.
4. Configure each username with a unique password of at least 12 characters, using the private setup code.
5. Sign in at `https://paulihq.com/login`.

Passwords are salted and hashed with PBKDF2. Failed login attempts are rate-limited, and sessions use random tokens stored in D1 with secure HTTP-only cookies.

Never commit passwords, the setup code, API keys, or other secrets to this repository.
