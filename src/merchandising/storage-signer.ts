import { createClient } from "@supabase/supabase-js";

import type { MediaUploadSigner } from "../catalog/catalog-management-service";

/**
 * Supabase Storage implementation of MediaUploadSigner. It mints a short-lived signed upload URL for a
 * bucket/path that the SERVER already chose and authorized — the caller can never influence the
 * destination. When Storage is unreachable or the bucket is missing it returns null, which the contract
 * already models as "storage not configured in this environment" (uploadUrl: null).
 */
export function createSupabaseMediaUploadSigner(configuration: {
  url: string;
  serviceRoleKey: string;
}): MediaUploadSigner {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async sign(bucket, path) {
      try {
        const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(path);
        if (error || !data?.signedUrl) return null;
        // Supabase signed upload URLs are valid for two hours.
        return {
          url: data.signedUrl,
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        };
      } catch {
        return null;
      }
    },
  };
}
