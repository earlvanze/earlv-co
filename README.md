# earlv.co

Static personal landing page for Earl Co.

## Deploy to Cloudflare Pages

After `earlv.co` has been added to the Cloudflare account and its nameservers have propagated:

```bash
npx wrangler pages deploy . --project-name earlv-co --branch main
```

In Cloudflare Pages, add `earlv.co` and `www.earlv.co` as custom domains. Cloudflare will create the needed DNS records once the zone is active.

No build step is required. The published directory is the repository root.
