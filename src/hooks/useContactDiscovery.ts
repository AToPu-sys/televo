import * as Contacts from "expo-contacts";
import * as Crypto from "expo-crypto";
import { useCallback, useState } from "react";

import { normalizePhone } from "../lib/phone";
import { supabase } from "../lib/supabase";

export type DiscoveredFriend = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  contactName: string;
};

async function sha256Hex(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

export function useContactDiscovery(userId: string | undefined) {
  const [status, setStatus] = useState<"idle" | "loading" | "denied" | "done" | "error">("idle");
  const [matches, setMatches] = useState<DiscoveredFriend[]>([]);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    if (!userId) return;
    setStatus("loading");
    setError(null);

    const { status: permission } = await Contacts.requestPermissionsAsync();
    if (permission !== "granted") {
      setStatus("denied");
      return;
    }

    try {
      const { data: contacts } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
      });

      // Hash every number in the address book, keeping a map back to the
      // contact's name so a match can be labeled "in your contacts as X".
      const hashToContactName = new Map<string, string>();
      for (const contact of contacts) {
        for (const phoneEntry of contact.phoneNumbers ?? []) {
          if (!phoneEntry.number) continue;
          const normalized = normalizePhone(phoneEntry.number);
          if (!normalized) continue;
          hashToContactName.set(await sha256Hex(normalized), contact.name ?? "Contact");
        }
      }

      if (hashToContactName.size === 0) {
        setMatches([]);
        setStatus("done");
        return;
      }

      // Only hashes leave the device, and the RPC only ever returns profiles
      // whose number the caller ALREADY had. Previously this downloaded
      // every registered phone number to the client, which was a full
      // reverse-lookup dump of the user base (phone -> name -> username).
      const { data: found, error: rpcError } = await supabase.rpc("match_contact_phones", {
        phone_hashes: Array.from(hashToContactName.keys()),
      });

      if (rpcError) throw rpcError;

      setMatches(
        (found ?? []).map((row: {
          id: string;
          username: string;
          display_name: string;
          avatar_url: string | null;
          matched_hash: string;
        }) => ({
          id: row.id,
          displayName: row.display_name,
          username: String(row.username),
          avatarUrl: row.avatar_url,
          contactName: hashToContactName.get(row.matched_hash) ?? "Contact",
        }))
      );
      setStatus("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      setStatus("error");
    }
  }, [userId]);

  return { status, matches, error, scan };
}
