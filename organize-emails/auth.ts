// usage: npm run auth [-- <account-name>]   (one-time Gmail sign-in per inbox; default account is "default")
import { authorize } from "./google-auth.ts";

await authorize(process.argv[2]);
