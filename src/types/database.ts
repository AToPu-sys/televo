export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activities: {
        Row: {
          created_at: string
          distance_meters: number
          duration_seconds: number
          ended_at: string
          id: string
          started_at: string
          title: string | null
          type: Database["public"]["Enums"]["activity_type"]
          updated_at: string
          user_id: string
          visibility: Database["public"]["Enums"]["activity_visibility"]
        }
        Insert: {
          created_at?: string
          distance_meters?: number
          duration_seconds: number
          ended_at: string
          id?: string
          started_at: string
          title?: string | null
          type: Database["public"]["Enums"]["activity_type"]
          updated_at?: string
          user_id: string
          visibility?: Database["public"]["Enums"]["activity_visibility"]
        }
        Update: {
          created_at?: string
          distance_meters?: number
          duration_seconds?: number
          ended_at?: string
          id?: string
          started_at?: string
          title?: string | null
          type?: Database["public"]["Enums"]["activity_type"]
          updated_at?: string
          user_id?: string
          visibility?: Database["public"]["Enums"]["activity_visibility"]
        }
        Relationships: []
      }
      activity_comments: {
        Row: {
          activity_id: string
          body: string
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          activity_id: string
          body: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          activity_id?: string
          body?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_comments_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_likes: {
        Row: {
          activity_id: string
          created_at: string
          user_id: string
        }
        Insert: {
          activity_id: string
          created_at?: string
          user_id: string
        }
        Update: {
          activity_id?: string
          created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_likes_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_points: {
        Row: {
          activity_id: string
          altitude_meters: number | null
          id: number
          lat: number
          lng: number
          recorded_at: string
          sequence: number
          speed_mps: number | null
        }
        Insert: {
          activity_id: string
          altitude_meters?: number | null
          id?: never
          lat: number
          lng: number
          recorded_at: string
          sequence: number
          speed_mps?: number | null
        }
        Update: {
          activity_id?: string
          altitude_meters?: number | null
          id?: never
          lat?: number
          lng?: number
          recorded_at?: string
          sequence?: number
          speed_mps?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_points_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_shares: {
        Row: {
          activity_id: string
          created_at: string
          user_id: string
        }
        Insert: {
          activity_id: string
          created_at?: string
          user_id: string
        }
        Update: {
          activity_id?: string
          created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_shares_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
        ]
      }
      blocked_users: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
        }
        Relationships: []
      }
      call_diagnostics: {
        Row: {
          bytes_received: number | null
          call_id: string
          id: number
          jitter_ms: number | null
          ms_to_media: number | null
          outcome: string
          packets_lost: number | null
          reported_at: string
          selected_candidate_pair: string | null
          trace: string | null
          turn_server: string | null
          user_id: string
          using_public_turn: boolean | null
        }
        Insert: {
          bytes_received?: number | null
          call_id: string
          id?: never
          jitter_ms?: number | null
          ms_to_media?: number | null
          outcome: string
          packets_lost?: number | null
          reported_at?: string
          selected_candidate_pair?: string | null
          trace?: string | null
          turn_server?: string | null
          user_id: string
          using_public_turn?: boolean | null
        }
        Update: {
          bytes_received?: number | null
          call_id?: string
          id?: never
          jitter_ms?: number | null
          ms_to_media?: number | null
          outcome?: string
          packets_lost?: number | null
          reported_at?: string
          selected_candidate_pair?: string | null
          trace?: string | null
          turn_server?: string | null
          user_id?: string
          using_public_turn?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "call_diagnostics_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
        ]
      }
      call_participants: {
        Row: {
          call_id: string
          joined_at: string
          left_at: string | null
          user_id: string
        }
        Insert: {
          call_id: string
          joined_at?: string
          left_at?: string | null
          user_id: string
        }
        Update: {
          call_id?: string
          joined_at?: string
          left_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_participants_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          answered_at: string | null
          caller_id: string
          conversation_id: string
          ended_at: string | null
          id: string
          kind: Database["public"]["Enums"]["call_kind"]
          started_at: string
          status: Database["public"]["Enums"]["call_status"]
        }
        Insert: {
          answered_at?: string | null
          caller_id: string
          conversation_id: string
          ended_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["call_kind"]
          started_at?: string
          status?: Database["public"]["Enums"]["call_status"]
        }
        Update: {
          answered_at?: string | null
          caller_id?: string
          conversation_id?: string
          ended_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["call_kind"]
          started_at?: string
          status?: Database["public"]["Enums"]["call_status"]
        }
        Relationships: [
          {
            foreignKeyName: "calls_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      challenge_participants: {
        Row: {
          challenge_id: string
          joined_at: string
          user_id: string
        }
        Insert: {
          challenge_id: string
          joined_at?: string
          user_id: string
        }
        Update: {
          challenge_id?: string
          joined_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenge_participants_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      challenges: {
        Row: {
          activity_type: Database["public"]["Enums"]["activity_type"] | null
          created_at: string
          created_by: string
          description: string | null
          ends_at: string
          id: string
          is_team_goal: boolean
          metric: Database["public"]["Enums"]["challenge_metric"]
          starts_at: string
          target: number | null
          title: string
        }
        Insert: {
          activity_type?: Database["public"]["Enums"]["activity_type"] | null
          created_at?: string
          created_by: string
          description?: string | null
          ends_at: string
          id?: string
          is_team_goal?: boolean
          metric: Database["public"]["Enums"]["challenge_metric"]
          starts_at: string
          target?: number | null
          title: string
        }
        Update: {
          activity_type?: Database["public"]["Enums"]["activity_type"] | null
          created_at?: string
          created_by?: string
          description?: string | null
          ends_at?: string
          id?: string
          is_team_goal?: boolean
          metric?: Database["public"]["Enums"]["challenge_metric"]
          starts_at?: string
          target?: number | null
          title?: string
        }
        Relationships: []
      }
      content_reports: {
        Row: {
          conversation_id: string | null
          created_at: string
          id: string
          message_id: string | null
          reason: string
          reported_content: string | null
          reported_user_id: string | null
          reporter_id: string
          status: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          id?: string
          message_id?: string | null
          reason: string
          reported_content?: string | null
          reported_user_id?: string | null
          reporter_id: string
          status?: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          id?: string
          message_id?: string | null
          reason?: string
          reported_content?: string | null
          reported_user_id?: string | null
          reporter_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_reports_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_reports_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_participants: {
        Row: {
          conversation_id: string
          deleted_at: string | null
          is_admin: boolean
          joined_at: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          deleted_at?: string | null
          is_admin?: boolean
          joined_at?: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          deleted_at?: string | null
          is_admin?: boolean
          joined_at?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_participants_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          created_by: string
          id: string
          is_encrypted: boolean
          kind: Database["public"]["Enums"]["conversation_kind"]
          self_destruct_seconds: number | null
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          is_encrypted?: boolean
          kind: Database["public"]["Enums"]["conversation_kind"]
          self_destruct_seconds?: number | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          is_encrypted?: boolean
          kind?: Database["public"]["Enums"]["conversation_kind"]
          self_destruct_seconds?: number | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      encrypted_session_keys: {
        Row: {
          conversation_id: string
          created_at: string
          encrypted_key: string
          kem_ciphertext: string | null
          nonce: string
          recipient_id: string
          sender_public_key: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          encrypted_key: string
          kem_ciphertext?: string | null
          nonce: string
          recipient_id: string
          sender_public_key: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          encrypted_key?: string
          kem_ciphertext?: string | null
          nonce?: string
          recipient_id?: string
          sender_public_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "encrypted_session_keys_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          addressee_id: string
          created_at: string
          id: string
          requester_id: string
          status: Database["public"]["Enums"]["friendship_status"]
          updated_at: string
        }
        Insert: {
          addressee_id: string
          created_at?: string
          id?: string
          requester_id: string
          status?: Database["public"]["Enums"]["friendship_status"]
          updated_at?: string
        }
        Update: {
          addressee_id?: string
          created_at?: string
          id?: string
          requester_id?: string
          status?: Database["public"]["Enums"]["friendship_status"]
          updated_at?: string
        }
        Relationships: []
      }
      goals: {
        Row: {
          created_at: string
          id: string
          metric: Database["public"]["Enums"]["goal_metric"]
          period: Database["public"]["Enums"]["goal_period"]
          target: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          metric: Database["public"]["Enums"]["goal_metric"]
          period: Database["public"]["Enums"]["goal_period"]
          target: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          metric?: Database["public"]["Enums"]["goal_metric"]
          period?: Database["public"]["Enums"]["goal_period"]
          target?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          body: string | null
          conversation_id: string
          created_at: string
          document_name: string | null
          document_size_bytes: number | null
          edited_at: string | null
          expires_at: string | null
          forwarded_from_message_id: string | null
          forwarded_from_sender_id: string | null
          id: string
          kind: Database["public"]["Enums"]["message_kind"]
          media_url: string | null
          reply_to_id: string | null
          sender_id: string
          shared_activity_id: string | null
          shared_profile_id: string | null
        }
        Insert: {
          body?: string | null
          conversation_id: string
          created_at?: string
          document_name?: string | null
          document_size_bytes?: number | null
          edited_at?: string | null
          expires_at?: string | null
          forwarded_from_message_id?: string | null
          forwarded_from_sender_id?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["message_kind"]
          media_url?: string | null
          reply_to_id?: string | null
          sender_id: string
          shared_activity_id?: string | null
          shared_profile_id?: string | null
        }
        Update: {
          body?: string | null
          conversation_id?: string
          created_at?: string
          document_name?: string | null
          document_size_bytes?: number | null
          edited_at?: string | null
          expires_at?: string | null
          forwarded_from_message_id?: string | null
          forwarded_from_sender_id?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["message_kind"]
          media_url?: string | null
          reply_to_id?: string | null
          sender_id?: string
          shared_activity_id?: string | null
          shared_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_forwarded_from_message_id_fkey"
            columns: ["forwarded_from_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_reply_to_id_fkey"
            columns: ["reply_to_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_shared_activity_id_fkey"
            columns: ["shared_activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_shared_profile_id_fkey"
            columns: ["shared_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      moderation_decisions: {
        Row: {
          action: string
          created_at: string
          decided_by: string
          id: number
          rationale: string | null
          report_id: string
          reported_user_id: string
          severity: string
        }
        Insert: {
          action: string
          created_at?: string
          decided_by?: string
          id?: never
          rationale?: string | null
          report_id: string
          reported_user_id: string
          severity: string
        }
        Update: {
          action?: string
          created_at?: string
          decided_by?: string
          id?: never
          rationale?: string | null
          report_id?: string
          reported_user_id?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "moderation_decisions_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "content_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      moderators: {
        Row: {
          added_at: string
          user_id: string
        }
        Insert: {
          added_at?: string
          user_id: string
        }
        Update: {
          added_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ops_alerts: {
        Row: {
          created_at: string
          detail: string
          id: number
          kind: string
        }
        Insert: {
          created_at?: string
          detail: string
          id?: never
          kind: string
        }
        Update: {
          created_at?: string
          detail?: string
          id?: never
          kind?: string
        }
        Relationships: []
      }
      otp_codes: {
        Row: {
          attempts: number
          code_hash: string
          created_at: string
          email: string
          expires_at: string
          id: string
        }
        Insert: {
          attempts?: number
          code_hash: string
          created_at?: string
          email: string
          expires_at: string
          id?: string
        }
        Update: {
          attempts?: number
          code_hash?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          created_at: string
          default_activity_visibility: Database["public"]["Enums"]["activity_visibility"]
          display_name: string
          e2e_kyber_public_key: string | null
          e2e_public_key: string | null
          id: string
          language: string
          last_seen_at: string | null
          onboarding_completed_at: string | null
          phone: string | null
          show_last_seen: boolean
          show_read_receipts: boolean
          sports: string[]
          units: string
          updated_at: string
          username: string
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          default_activity_visibility?: Database["public"]["Enums"]["activity_visibility"]
          display_name: string
          e2e_kyber_public_key?: string | null
          e2e_public_key?: string | null
          id: string
          language?: string
          last_seen_at?: string | null
          onboarding_completed_at?: string | null
          phone?: string | null
          show_last_seen?: boolean
          show_read_receipts?: boolean
          sports?: string[]
          units?: string
          updated_at?: string
          username: string
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          default_activity_visibility?: Database["public"]["Enums"]["activity_visibility"]
          display_name?: string
          e2e_kyber_public_key?: string | null
          e2e_public_key?: string | null
          id?: string
          language?: string
          last_seen_at?: string | null
          onboarding_completed_at?: string | null
          phone?: string | null
          show_last_seen?: boolean
          show_read_receipts?: boolean
          sports?: string[]
          units?: string
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      push_tokens: {
        Row: {
          created_at: string
          device_name: string | null
          expo_push_token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_name?: string | null
          expo_push_token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_name?: string | null
          expo_push_token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      segment_efforts: {
        Row: {
          achieved_at: string
          activity_id: string
          created_at: string
          elapsed_seconds: number
          id: string
          segment_id: string
          user_id: string
        }
        Insert: {
          achieved_at: string
          activity_id: string
          created_at?: string
          elapsed_seconds: number
          id?: string
          segment_id: string
          user_id: string
        }
        Update: {
          achieved_at?: string
          activity_id?: string
          created_at?: string
          elapsed_seconds?: number
          id?: string
          segment_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "segment_efforts_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "segment_efforts_segment_id_fkey"
            columns: ["segment_id"]
            isOneToOne: false
            referencedRelation: "segments"
            referencedColumns: ["id"]
          },
        ]
      }
      segments: {
        Row: {
          activity_type: Database["public"]["Enums"]["activity_type"]
          created_at: string
          created_by: string
          distance_meters: number
          end_lat: number
          end_lng: number
          id: string
          name: string
          route: Json
          start_lat: number
          start_lng: number
        }
        Insert: {
          activity_type?: Database["public"]["Enums"]["activity_type"]
          created_at?: string
          created_by: string
          distance_meters: number
          end_lat: number
          end_lng: number
          id?: string
          name: string
          route?: Json
          start_lat: number
          start_lng: number
        }
        Update: {
          activity_type?: Database["public"]["Enums"]["activity_type"]
          created_at?: string
          created_by?: string
          distance_meters?: number
          end_lat?: number
          end_lng?: number
          id?: string
          name?: string
          route?: Json
          start_lat?: number
          start_lng?: number
        }
        Relationships: []
      }
      user_moderation: {
        Row: {
          banned_reason: string | null
          banned_until: string | null
          strikes: number
          updated_at: string
          user_id: string
        }
        Insert: {
          banned_reason?: string | null
          banned_until?: string | null
          strikes?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          banned_reason?: string | null
          banned_until?: string | null
          strikes?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      voip_push_tokens: {
        Row: {
          apns_token: string
          created_at: string
          device_name: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          apns_token: string
          created_at?: string
          device_name?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          apns_token?: string
          created_at?: string
          device_name?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      waitlist: {
        Row: {
          created_at: string
          email: string
          id: string
          source: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          source?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          source?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      any_session_key_exists: {
        Args: { p_conversation_id: string }
        Returns: boolean
      }
      apply_moderation_decision: {
        Args: {
          p_decided_by?: string
          p_rationale: string
          p_report_id: string
          p_severity: string
        }
        Returns: Json
      }
      are_friends: {
        Args: { user_a: string; user_b: string }
        Returns: boolean
      }
      call_id_from_topic: { Args: { topic: string }; Returns: string }
      chat_list_summary: {
        Args: never
        Returns: {
          conversation_id: string
          last_message_at: string
          last_message_body: string
          last_message_kind: Database["public"]["Enums"]["message_kind"]
          last_message_sender_id: string
          unread_count: number
        }[]
      }
      check_apns_cert_expiry: { Args: never; Returns: undefined }
      claim_expo_push_token: {
        Args: { p_device_name?: string; p_token: string }
        Returns: undefined
      }
      claim_voip_push_token: {
        Args: { p_device_name?: string; p_token: string }
        Returns: undefined
      }
      conversation_id_from_typing_topic: {
        Args: { topic: string }
        Returns: string
      }
      delete_expired_messages: { Args: never; Returns: number }
      delete_own_account: { Args: never; Returns: undefined }
      deposit_session_key_if_missing: {
        Args: {
          p_conversation_id: string
          p_encrypted_key: string
          p_kem_ciphertext?: string
          p_nonce: string
          p_recipient_id: string
          p_sender_public_key: string
        }
        Returns: boolean
      }
      find_user: {
        Args: { term: string }
        Returns: {
          avatar_url: string
          bio: string
          display_name: string
          id: string
          username: string
        }[]
      }
      get_activity_streak: { Args: { profile_id: string }; Returns: number }
      get_challenge_leaderboard: {
        Args: { challenge_id_input: string }
        Returns: {
          activity_count: number
          score: number
          user_id: string
        }[]
      }
      get_friend_count: { Args: { profile_id: string }; Returns: number }
      get_goal_progress: {
        Args: { goal_id_input: string }
        Returns: {
          period_end: string
          period_start: string
          progress: number
        }[]
      }
      get_my_phone: { Args: never; Returns: string }
      get_personal_records: {
        Args: {
          for_activity_type: Database["public"]["Enums"]["activity_type"]
          profile_id: string
        }
        Returns: {
          achieved_at: string
          activity_id: string
          best_duration_seconds: number
          bucket_meters: number
        }[]
      }
      get_profile_stats: {
        Args: { profile_id: string }
        Returns: {
          activity_count: number
          total_distance_meters: number
        }[]
      }
      get_segment_leaderboard: {
        Args: { segment_id_input: string }
        Returns: {
          achieved_at: string
          activity_id: string
          best_elapsed_seconds: number
          user_id: string
        }[]
      }
      get_team_goal_progress: {
        Args: { challenge_id_input: string }
        Returns: {
          participant_count: number
          total_progress: number
        }[]
      }
      get_training_profile: {
        Args: { profile_id: string }
        Returns: {
          activity_count: number
          avg_distance_meters: number
          avg_duration_seconds: number
          avg_pace_seconds_per_km: number
          favorite_hour_of_day: number
          favorite_type: Database["public"]["Enums"]["activity_type"]
        }[]
      }
      get_user_id_by_email: { Args: { lookup_email: string }; Returns: string }
      haversine_meters: {
        Args: { lat1: number; lat2: number; lng1: number; lng2: number }
        Returns: number
      }
      is_blocked_between: {
        Args: { user_a: string; user_b: string }
        Returns: boolean
      }
      is_conversation_participant: {
        Args: { conversation: string; member: string }
        Returns: boolean
      }
      is_moderator: { Args: { uid: string }; Returns: boolean }
      is_username_available: {
        Args: { check_username: string }
        Returns: boolean
      }
      match_contact_phones: {
        Args: { phone_hashes: string[] }
        Returns: {
          avatar_url: string
          display_name: string
          id: string
          matched_hash: string
          username: string
        }[]
      }
      match_segment_efforts: {
        Args: { activity_id_input: string }
        Returns: {
          achieved_at: string
          activity_id: string
          created_at: string
          elapsed_seconds: number
          id: string
          segment_id: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "segment_efforts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      record_apns_cert_alerts: { Args: never; Returns: undefined }
      resolve_report: {
        Args: { outcome: string; report_id: string }
        Returns: undefined
      }
      reverse_moderation: { Args: { p_user_id: string }; Returns: undefined }
      review_queue: {
        Args: never
        Returns: {
          created_at: string
          id: string
          message_id: string
          reason: string
          reported_content: string
          reported_user_id: string
          reporter_id: string
          status: string
        }[]
      }
      session_meets_mfa_requirement: { Args: never; Returns: boolean }
      set_my_phone: { Args: { new_phone?: string }; Returns: undefined }
    }
    Enums: {
      activity_type:
        | "run"
        | "ride"
        | "walk"
        | "hike"
        | "swim"
        | "strength"
        | "yoga"
        | "hiit"
        | "rowing"
        | "skiing"
        | "snowboarding"
        | "elliptical"
        | "workout"
        | "other"
        | "soccer"
        | "basketball"
        | "tennis"
        | "golf"
        | "volleyball"
        | "baseball"
        | "table_tennis"
        | "sailing"
        | "surfing"
        | "skateboarding"
        | "climbing"
        | "pilates"
        | "horseback_riding"
        | "fishing"
        | "wheelchair"
        | "inline_skating"
      activity_visibility: "public" | "friends" | "private" | "custom"
      call_kind: "audio" | "video"
      call_status: "ringing" | "active" | "ended" | "missed" | "declined"
      challenge_metric: "distance" | "duration" | "activity_count"
      conversation_kind: "direct" | "group"
      friendship_status: "pending" | "accepted" | "declined" | "blocked"
      goal_metric: "distance" | "duration" | "activity_count"
      goal_period: "weekly" | "monthly"
      message_kind:
        | "text"
        | "image"
        | "video"
        | "activity_share"
        | "contact_share"
        | "document"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      activity_type: [
        "run",
        "ride",
        "walk",
        "hike",
        "swim",
        "strength",
        "yoga",
        "hiit",
        "rowing",
        "skiing",
        "snowboarding",
        "elliptical",
        "workout",
        "other",
        "soccer",
        "basketball",
        "tennis",
        "golf",
        "volleyball",
        "baseball",
        "table_tennis",
        "sailing",
        "surfing",
        "skateboarding",
        "climbing",
        "pilates",
        "horseback_riding",
        "fishing",
        "wheelchair",
        "inline_skating",
      ],
      activity_visibility: ["public", "friends", "private", "custom"],
      call_kind: ["audio", "video"],
      call_status: ["ringing", "active", "ended", "missed", "declined"],
      challenge_metric: ["distance", "duration", "activity_count"],
      conversation_kind: ["direct", "group"],
      friendship_status: ["pending", "accepted", "declined", "blocked"],
      goal_metric: ["distance", "duration", "activity_count"],
      goal_period: ["weekly", "monthly"],
      message_kind: [
        "text",
        "image",
        "video",
        "activity_share",
        "contact_share",
        "document",
      ],
    },
  },
} as const
