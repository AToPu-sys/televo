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
      conversation_participants: {
        Row: {
          conversation_id: string
          is_admin: boolean
          joined_at: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          is_admin?: boolean
          joined_at?: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
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
          kind: Database["public"]["Enums"]["conversation_kind"]
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          kind: Database["public"]["Enums"]["conversation_kind"]
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          kind?: Database["public"]["Enums"]["conversation_kind"]
          title?: string | null
          updated_at?: string
        }
        Relationships: []
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
          id: string
          kind: Database["public"]["Enums"]["message_kind"]
          media_url: string | null
          sender_id: string
          shared_activity_id: string | null
          shared_profile_id: string | null
        }
        Insert: {
          body?: string | null
          conversation_id: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["message_kind"]
          media_url?: string | null
          sender_id: string
          shared_activity_id?: string | null
          shared_profile_id?: string | null
        }
        Update: {
          body?: string | null
          conversation_id?: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["message_kind"]
          media_url?: string | null
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
          id: string
          language: string
          onboarding_completed_at: string | null
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
          id: string
          language?: string
          onboarding_completed_at?: string | null
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
          id?: string
          language?: string
          onboarding_completed_at?: string | null
          sports?: string[]
          units?: string
          updated_at?: string
          username?: string
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      are_friends: {
        Args: { user_a: string; user_b: string }
        Returns: boolean
      }
      delete_own_account: { Args: never; Returns: undefined }
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
      is_conversation_participant: {
        Args: { conversation: string; member: string }
        Returns: boolean
      }
      is_username_available: {
        Args: { check_username: string }
        Returns: boolean
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
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
      ],
    },
  },
} as const
