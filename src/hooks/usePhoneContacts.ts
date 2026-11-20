import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Contacts from "expo-contacts";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

import { normalizePhone } from "../lib/phone";
import { supabase } from "../lib/supabase";

/** A phone-book contact, as shown in the Contacts tab. */
export type PhoneContact = {
  key: string;
  name: string;
  phone: string;
  /** Set when one of this contact's numbers belongs to a Televo account. */
  televo: { id: string; displayName: string; username: string; avatarUrl: string | null } | null;
};

type Match = { id: string; username: string; display_name: string; avatar_url: string | null; matched_hash: string };

// The server allows a few matching runs a day (083); the phone book itself
// is read on the device every time, only the matching is cached.
const MATCH_TTL_MS = 6 * 60 * 60 * 1000;
const cacheKey = (userId: string) => `televo.contact-matches.${userId}`;

async function sha256Hex(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

/**
 * The phone book, split into people already on Televo and people to invite.
 * Nothing is read or sent until the person allows contacts access with
 * `requestAccess` (an explicit tap); after that it refreshes on its own.
 * Only SHA-256 hashes of normalised numbers ever leave the device.
 */
export function usePhoneContacts(userId: string | undefined) {
  const supported = Platform.OS !== "web";
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied" | "undetermined">("unknown");
  const [contacts, setContacts] = useState<PhoneContact[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!supported || !userId) return;
    setLoading(true);
    try {
      const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name] });

      // One entry per person, keeping every number for matching.
      const people: { key: string; name: string; phones: string[] }[] = [];
      for (const c of data) {
        const phones = (c.phoneNumbers ?? [])
          .map((p) => (p.number ? normalizePhone(p.number) : null))
          .filter((p): p is string => !!p);
        if (!phones.length) continue;
        people.push({ key: c.id ?? `${c.name}-${phones[0]}`, name: c.name || phones[0], phones: [...new Set(phones)] });
      }

      const hashOf = new Map<string, string>();
      for (const person of people) for (const phone of person.phones) hashOf.set(phone, await sha256Hex(phone));

      let matches: Match[] = [];
      const cachedRaw = await AsyncStorage.getItem(cacheKey(userId)).catch(() => null);
      const cached = cachedRaw ? (JSON.parse(cachedRaw) as { at: number; matches: Match[] }) : null;
      if (cached && Date.now() - cached.at < MATCH_TTL_MS) {
        matches = cached.matches;
      } else {
        const hashes = [...new Set(hashOf.values())].slice(0, 10000);
        const { data: found, error } = hashes.length
          ? await supabase.rpc("match_contact_phones", { phone_hashes: hashes })
          : { data: [], error: null };
        if (error) {
          matches = cached?.matches ?? []; // rate-limited or offline: keep the last answer
        } else {
          matches = (found ?? []) as Match[];
          await AsyncStorage.setItem(cacheKey(userId), JSON.stringify({ at: Date.now(), matches })).catch(() => {});
        }
      }

      const byHash = new Map(matches.filter((m) => m.id !== userId).map((m) => [m.matched_hash, m]));
      const result: PhoneContact[] = people.map((person) => {
        const hit = person.phones.map((p) => byHash.get(hashOf.get(p) ?? "")).find(Boolean);
        return {
          key: person.key,
          name: person.name,
          phone: person.phones[0],
          televo: hit
            ? { id: hit.id, displayName: hit.display_name, username: String(hit.username), avatarUrl: hit.avatar_url }
            : null,
        };
      });
      result.sort((a, b) => a.name.localeCompare(b.name));
      setContacts(result);
    } finally {
      setLoading(false);
    }
  }, [supported, userId]);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void Contacts.getPermissionsAsync().then(({ status }) => {
      if (!active) return;
      const next = status === "granted" ? "granted" : status === "denied" ? "denied" : "undetermined";
      setPermission(next);
      if (next === "granted") void load();
    });
    return () => {
      active = false;
    };
  }, [supported, load]);

  const requestAccess = useCallback(async () => {
    if (!supported) return;
    const { status } = await Contacts.requestPermissionsAsync();
    const next = status === "granted" ? "granted" : "denied";
    setPermission(next);
    if (next === "granted") await load();
  }, [supported, load]);

  return { supported, permission, contacts, loading, requestAccess, refresh: load };
}
