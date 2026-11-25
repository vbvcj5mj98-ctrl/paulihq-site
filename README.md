# Pauli HQ

A Cloudflare-first family website with a public sign-in page and a private household workspace.

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

## Parcel Scout and nationwide APN lookup

Parcel Scout's quick lookup checks structured RentCast data for an exact address when available, then uses a bounded OpenAI web lookup when needed. APN searches require county and two-letter state because parcel numbers are commonly reused. Deeper ownership and pricing checks are separate actions; an expired or failed refresh does not replace a saved verified report.

Unstarred lookups are cached for 90 days. Starred properties remain saved until the user removes the star. The site enforces a maximum of 20 new AI property investigations per calendar month; cached results do not use that allowance. No Regrid account or secret is required.

## Property Finder

Saved searches refresh weekly by default. The owner can change the schedule for the shared Northwest Arkansas search or refresh one saved search manually. Each successful refresh replaces what counts as current, including when there are zero matches. Starred historical copies remain visible with their availability marked. Results must match supported explicit filters (including state, price, acreage, and house size); a missing value doesn't pass a required filter. One-time AI searches retain their own filters and don't become recurring requests automatically. The shared RentCast monthly cap remains 50.

## Photo Drop: private queue → Windows PC → NAS

Only Carson and Jessi can open Photo Drop or list their own uploads. The browser encrypts the original filename and data with the home PC's public [age key](https://github.com/FiloSottile/age) before sending anything. Cloudflare sees encrypted bytes, sizes, account associations and timing; it never receives the private key. This assumes the Pauli HQ site and the browser are trusted. The PC retains an encrypted copy and sends those same encrypted bytes to the NAS. No incoming ports or public NAS address are needed.

### Cloudflare setup

1. Enable R2 if needed, then create a **private Standard** bucket named `paulihq-photo-drop`. R2 is usage-billed above the [free allowances](https://developers.cloudflare.com/r2/pricing/). Do not enable the public bucket URL or a bucket custom domain. Set an [object lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) to delete objects at the `photo-drop/v1/` prefix after 8 days as a cleanup backstop.
2. Add an `r2_buckets` entry to `wrangler.jsonc`: `{"binding":"PHOTO_DROP_BUCKET","bucket_name":"paulihq-photo-drop"}`. The site deliberately remains usable without this binding; it will show that Photo Drop is not set up yet.
3. Apply only the additive queue migration to the existing D1 database before turning on Photo Drop: `npx wrangler d1 execute paulihq-auth --remote --file drizzle/0014_photo_drop.sql`. Keep the existing authentication database and bindings.
4. Set `PHOTO_DROP_RECIPIENT` to the public `age1…` recipient from the PC. Set `PHOTO_DROP_AGENT_TOKEN` as an encrypted Worker secret, using 32 random bytes encoded as base64url or hex. Do not commit either the device token or private identity, and do not reuse your Pauli HQ password. Deploy using the existing Worker workflow.

### Home PC setup and first test

1. Install [age](https://github.com/FiloSottile/age/releases) from its official release and use `age-keygen -o <local-identity-file>` to generate the PC identity. Keep that file in a protected local folder, separate from the upload inbox. Keep a secure offline recovery copy. Use `age-keygen -y <local-identity-file>` to get only the public recipient for Cloudflare.
2. In a private Windows PowerShell session, calculate the 16-character phone pairing code from that public recipient. Get the code from the PC rather than copying it from a web page:

   ```powershell
   $photoRecipient = (& age-keygen -y 'C:\YourPrivateFolder\photo-drop-identity.txt').Trim()
   $photoHasher = [Security.Cryptography.SHA256]::Create()
   try {
     $photoBytes = [Text.Encoding]::UTF8.GetBytes($photoRecipient)
     ([BitConverter]::ToString($photoHasher.ComputeHash($photoBytes)) -replace '-', '').Substring(0,16).ToLowerInvariant()
   } finally { $photoHasher.Dispose() }
   ```

3. Set the receiver's environment under the Windows user who runs it. `PAULI_PHOTO_DROP_ORIGIN` is `https://paulihq.com`; `PAULI_PHOTO_DROP_AGENT_TOKEN` matches the Worker secret; `PAULI_PHOTO_DROP_INBOX` and `PAULI_PHOTO_DROP_AGE_IDENTITY` are existing absolute local paths. `PAULI_PHOTO_DROP_NAS` is a dedicated, already accessible UNC folder, for example `\\nas\PauliHQBackups`; use a restricted Windows/NAS account. `PAULI_PHOTO_DROP_AGE_BINARY` is optional if `age.exe` is on PATH. The Iomega's compatible share transport still needs to be verified. Do not expose it to the internet or enable SMB1 to make this work.
4. With Node.js 22.13 or newer, run `node scripts/photo-drop-bridge.mjs --once`. Pair each phone using the code from step 2, upload one non-sensitive test file, and run the receiver again. Confirm that the portal reaches **NAS backup verified**. Use `node scripts/photo-drop-restore.mjs <encrypted.age> <absolute-local-output-file>` to restore it from the NAS into a protected folder and compare it with the original. Only after that test, use Windows Task Scheduler to run the same `--once` command periodically under the restricted account. The current implementation does not install a scheduled task or start a background service.

Uploads are bounded to 25 MiB per file, 20 selections at a time, and a 2 GiB active queue. Keep the upload page open until a file shows **Waiting for PC**. A disconnected PC can collect files later, but the queue expires after seven days, so retain the original until **NAS backup verified**. A NAS outage leaves the PC copy intact and the connector retries it. The cloud copy is removed after verified NAS delivery or expiry. An incomplete or conflicting NAS copy is never overwritten automatically.
