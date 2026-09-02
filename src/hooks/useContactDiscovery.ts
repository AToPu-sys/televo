import * as Contacts from "expo-contacts";
import { useCallback, useState } from "react";

import { supabase } from "../lib/supabase";

export type DiscoveredFriend = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  contactName: string;
};

/** Keeps only digits, with a leading + if the original had one — good enough
 * to compare numbers that may be formatted differently on each side. */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : digits;
}

/** Last 9 digits, ignoring country code formatting differences, as a looser
 * fallback match for numbers stored without a leading + or country code. */
function last9Digits(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  return digits.slice(-9);
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

      const numberToContactName = new Map<string, string>();
      for (const contact of contacts) {
        for (const phoneEntry of contact.phoneNumbers ?? []) {
          if (!phoneEntry.number) continue;
          const exact = normalizePhone(phoneEntry.number);
          const loose = last9Digits(phoneEntry.number);
          if (exact) numberToContactName.set(exact, contact.name ?? "Contact");
          if (loose) numberToContactName.set(`~${loose}`, contact.name ?? "Contact");
        }
      }

      if (numberToContactName.size === 0) {
        setMatches([]);
        setStatus("done");
        return;
      }

      const { data: profiles, error: queryError } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url, phone")
        .not("phone", "is", null)
        .neq("id", userId);

      if (queryError) throw queryError;

      const found: DiscoveredFriend[] = [];
      for (const profile of profiles ?? []) {
        if (!profile.phone) continue;
        const exact = normalizePhone(profile.phone);
        const loose = last9Digits(profile.phone);
        const contactName =
          numberToContactName.get(exact) ?? numberToContactName.get(`~${loose}`);
        if (contactName) {
          found.push({
            id: profile.id,
            displayName: profile.display_name,
            username: String(profile.username),
            avatarUrl: profile.avatar_url,
            contactName,
          });
        }
      }

      setMatches(found);
      setStatus("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      setStatus("error");
    }
  }, [userId]);

  return { status, matches, error, scan };
}
