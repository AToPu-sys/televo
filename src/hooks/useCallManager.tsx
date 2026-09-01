import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { supabase } from "../lib/supabase";
import type { Database } from "../types/database";
import { useAuth } from "./useAuth";
import { useCall } from "./useCall";
import { useIncomingCalls } from "./useIncomingCalls";

type CallKind = Database["public"]["Enums"]["call_kind"];
type CallRow = Database["public"]["Tables"]["calls"]["Row"];

type PeerInfo = { name: string; avatarUrl: string | null };

type CallManagerValue = ReturnType<typeof useCall> & {
  peer: PeerInfo | null;
  placeCall: (conversationId: string, kind: CallKind) => Promise<void>;
};

const CallManagerContext = createContext<CallManagerValue | undefined>(undefined);

export function CallManagerProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const call = useCall(user?.id);
  const [peer, setPeer] = useState<PeerInfo | null>(null);
  const conversationPeerCache = useRef(new Map<string, PeerInfo>());

  const resolvePeer = useCallback(
    async (conversationId: string): Promise<PeerInfo> => {
      const cached = conversationPeerCache.current.get(conversationId);
      if (cached) return cached;

      const { data } = await supabase
        .from("conversations")
        .select("kind, title, conversation_participants ( user_id )")
        .eq("id", conversationId)
        .single();

      if (!data) return { name: "Unknown", avatarUrl: null };

      if (data.kind === "group") {
        const info = { name: data.title ?? "Group", avatarUrl: null };
        conversationPeerCache.current.set(conversationId, info);
        return info;
      }

      const other = (data.conversation_participants ?? []).find(
        (participant) => participant.user_id !== user?.id
      );
      if (!other) return { name: "Unknown", avatarUrl: null };

      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name, avatar_url")
        .eq("id", other.user_id)
        .single();

      const info = {
        name: profile?.display_name ?? "Unknown",
        avatarUrl: profile?.avatar_url ?? null,
      };
      conversationPeerCache.current.set(conversationId, info);
      return info;
    },
    [user?.id]
  );

  const placeCall = useCallback(
    async (conversationId: string, kind: CallKind) => {
      const info = await resolvePeer(conversationId);
      setPeer(info);
      await call.startCall(conversationId, kind);
    },
    [call, resolvePeer]
  );

  const handleIncoming = useCallback(
    async (incomingCall: CallRow) => {
      const info = await resolvePeer(incomingCall.conversation_id);
      setPeer(info);
      call.listenForOffer(incomingCall);
    },
    [call, resolvePeer]
  );

  useIncomingCalls(user?.id, handleIncoming);

  useEffect(() => {
    if (call.state.phase === "idle") {
      setPeer(null);
    }
  }, [call.state.phase]);

  return (
    <CallManagerContext.Provider value={{ ...call, peer, placeCall }}>
      {children}
    </CallManagerContext.Provider>
  );
}

export function useCallManager() {
  const context = useContext(CallManagerContext);
  if (!context) {
    throw new Error("useCallManager must be used within a CallManagerProvider");
  }
  return context;
}
