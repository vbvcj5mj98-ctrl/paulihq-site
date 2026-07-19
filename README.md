# Carson Pauli — Personal Landing Page

A simple photo-led landing page with a reserved login screen, built with Next.js and Tailwind CSS.

## Before publishing

The login screen is intentionally inactive. Before enabling it, connect it to a real authentication provider so passwords are never handled by an unprotected form.

## Run locally

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open the local address shown in the terminal.

## Deploy to Vercel

1. Create a GitHub repository and upload this project.
2. Sign in to Vercel and choose **Add New → Project**.
3. Import the GitHub repository and select **Deploy**. Vercel will detect Next.js automatically.
4. In the Vercel project, open **Settings → Domains** and add your domain.

## Connect a Cloudflare domain

1. Keep the domain active in Cloudflare; email forwarding can remain enabled.
2. In Vercel, add both the root domain (for example, `pauli.co`) and `www` version.
3. Vercel will show the exact DNS records it needs.
4. In Cloudflare, open **DNS → Records**, then add the records Vercel provides.
5. Remove only conflicting website records for the same host. Do not remove the MX and TXT records used by Email Routing.
6. Return to Vercel and wait for both domains to show **Valid Configuration**.

DNS updates often take effect within minutes, but can occasionally take longer.
