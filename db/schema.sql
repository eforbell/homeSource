-- HomeSource canonical schema snapshot.
-- Generated from the complete migration chain; verify with npm run test:schema-parity.

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: documents_search_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.documents_search_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.metadata::text, '')), 'C');
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;


--
-- Name: enforce_continuity_delivery_grant_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_continuity_delivery_grant_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'continuity delivery grants are durable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM continuity_packet_recipients recipient
      WHERE recipient.id = NEW.packet_recipient_id
        AND recipient.packet_version_id = NEW.packet_version_id
        AND recipient.role = NEW.role
        AND recipient.member_id IS NOT DISTINCT FROM NEW.member_id
        AND recipient.trustee_id IS NOT DISTINCT FROM NEW.trustee_id
    ) THEN
      RAISE EXCEPTION 'continuity delivery grant recipient does not match packet policy';
    END IF;
    IF NEW.member_contact_channel_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM member_contact_channels contact
      WHERE contact.id = NEW.member_contact_channel_id AND contact.member_id = NEW.member_id
        AND contact.channel_type = 'email' AND contact.status = 'verified'
        AND contact.normalized_address = NEW.destination_snapshot
    ) THEN
      RAISE EXCEPTION 'continuity delivery grant member contact does not match verified snapshot';
    END IF;
    IF NEW.trustee_contact_channel_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trustee_contact_channels contact
      WHERE contact.id = NEW.trustee_contact_channel_id AND contact.trustee_id = NEW.trustee_id
        AND contact.channel_type = 'email' AND contact.status = 'verified'
        AND contact.normalized_address = NEW.destination_snapshot
    ) THEN
      RAISE EXCEPTION 'continuity delivery grant trustee contact does not match verified snapshot';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id
     OR NEW.packet_version_id IS DISTINCT FROM OLD.packet_version_id
     OR NEW.packet_recipient_id IS DISTINCT FROM OLD.packet_recipient_id
     OR NEW.member_id IS DISTINCT FROM OLD.member_id
     OR NEW.trustee_id IS DISTINCT FROM OLD.trustee_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.member_contact_channel_id IS DISTINCT FROM OLD.member_contact_channel_id
     OR NEW.trustee_contact_channel_id IS DISTINCT FROM OLD.trustee_contact_channel_id
     OR NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot
     OR NEW.blocked_reason_class IS DISTINCT FROM OLD.blocked_reason_class
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.blocked_at IS DISTINCT FROM OLD.blocked_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity delivery grant identity is immutable';
  END IF;
  IF NOT (NEW.status = OLD.status OR (OLD.status = 'active' AND NEW.status = 'expired')) THEN
    RAISE EXCEPTION 'invalid continuity delivery grant transition';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: enforce_continuity_delivery_run_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_continuity_delivery_run_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.switch_id IS DISTINCT FROM OLD.switch_id
     OR NEW.schedule_cycle IS DISTINCT FROM OLD.schedule_cycle
     OR NEW.packet_version_id IS DISTINCT FROM OLD.packet_version_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity delivery run identity is immutable';
  END IF;
  IF OLD.first_grant_activated_at IS NOT NULL
     AND NEW.first_grant_activated_at IS DISTINCT FROM OLD.first_grant_activated_at THEN
    RAISE EXCEPTION 'continuity first grant activation boundary is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: enforce_continuity_packet_version_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_continuity_packet_version_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'continuity packet versions are immutable';
  END IF;
  IF NEW.switch_id IS DISTINCT FROM OLD.switch_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.letter_document_id IS DISTINCT FROM OLD.letter_document_id
     OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity packet version identity is immutable';
  END IF;
  IF NOT ((OLD.status = 'staged' AND NEW.status IN ('active', 'superseded'))
          OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'invalid continuity packet version transition';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: enforce_continuity_run_trustee_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_continuity_run_trustee_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id
     OR NEW.trustee_id IS DISTINCT FROM OLD.trustee_id
     OR NEW.contact_channel_id IS DISTINCT FROM OLD.contact_channel_id
     OR NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'continuity delivery trustee snapshot is immutable';
  END IF;
  IF OLD.first_successful_send_at IS NOT NULL
     AND NEW.first_successful_send_at IS DISTINCT FROM OLD.first_successful_send_at THEN
    RAISE EXCEPTION 'continuity trustee notification success is immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: reject_continuity_delivery_item_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_continuity_delivery_item_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'continuity delivery manifest items are immutable';
END;
$$;


--
-- Name: reject_continuity_packet_child_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_continuity_packet_child_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'continuity packet policy rows are immutable';
END;
$$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value text
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id integer NOT NULL,
    action text NOT NULL,
    entity_type text,
    entity_id integer,
    actor_id integer,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: backup_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_log (
    id integer NOT NULL,
    backup_type text NOT NULL,
    status text NOT NULL,
    file_path text,
    file_size_bytes bigint,
    document_count integer,
    encrypted boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    error_message text,
    CONSTRAINT backup_log_backup_type_check CHECK ((backup_type = ANY (ARRAY['full'::text, 'metadata_only'::text]))),
    CONSTRAINT backup_log_status_check CHECK ((status = ANY (ARRAY['started'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: backup_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.backup_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: backup_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.backup_log_id_seq OWNED BY public.backup_log.id;


--
-- Name: continuity_brrr_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_brrr_outbox (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    event_id integer,
    notification_channel_id integer,
    schedule_cycle bigint NOT NULL,
    notification_type text NOT NULL,
    channel_config_version bigint NOT NULL,
    target_fingerprint text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text,
    claim_expires_at timestamp with time zone,
    sent_at timestamp with time zone,
    failed_at timestamp with time zone,
    blocked_at timestamp with time zone,
    superseded_at timestamp with time zone,
    last_error_class text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_brrr_outbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT continuity_brrr_outbox_channel_config_version_check CHECK ((channel_config_version > 0)),
    CONSTRAINT continuity_brrr_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'sent'::text, 'failed'::text, 'blocked_configuration'::text, 'superseded'::text]))),
    CONSTRAINT continuity_brrr_outbox_target_fingerprint_check CHECK ((target_fingerprint ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: continuity_brrr_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_brrr_outbox_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_brrr_outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_brrr_outbox_id_seq OWNED BY public.continuity_brrr_outbox.id;


--
-- Name: continuity_checkin_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_checkin_tokens (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    schedule_cycle bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    replaced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_checkin_tokens_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: continuity_checkin_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_checkin_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_checkin_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_checkin_tokens_id_seq OWNED BY public.continuity_checkin_tokens.id;


--
-- Name: continuity_delivery_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_delivery_grants (
    id integer NOT NULL,
    delivery_run_id integer NOT NULL,
    packet_version_id integer NOT NULL,
    packet_recipient_id integer NOT NULL,
    member_id integer,
    trustee_id integer,
    role text NOT NULL,
    member_contact_channel_id integer,
    trustee_contact_channel_id integer,
    destination_snapshot text,
    status text NOT NULL,
    blocked_reason_class text,
    activated_at timestamp with time zone,
    expires_at timestamp with time zone,
    blocked_at timestamp with time zone,
    expired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_delivery_grants_blocked_reason_class_check CHECK ((blocked_reason_class ~ '^[a-z0-9_]{1,80}$'::text)),
    CONSTRAINT continuity_delivery_grants_check CHECK ((((role = 'beneficiary'::text) AND (member_id IS NOT NULL) AND (trustee_id IS NULL) AND (trustee_contact_channel_id IS NULL)) OR ((role = 'trustee'::text) AND (member_id IS NULL) AND (trustee_id IS NOT NULL) AND (member_contact_channel_id IS NULL)))),
    CONSTRAINT continuity_delivery_grants_check1 CHECK ((((status = 'active'::text) AND (activated_at IS NOT NULL) AND (expires_at IS NOT NULL) AND (destination_snapshot IS NOT NULL) AND (((role = 'beneficiary'::text) AND (member_contact_channel_id IS NOT NULL)) OR ((role = 'trustee'::text) AND (trustee_contact_channel_id IS NOT NULL))) AND (blocked_at IS NULL) AND (blocked_reason_class IS NULL) AND (expired_at IS NULL)) OR ((status = 'blocked'::text) AND (activated_at IS NULL) AND (expires_at IS NULL) AND (blocked_at IS NOT NULL) AND (blocked_reason_class IS NOT NULL) AND (expired_at IS NULL)) OR ((status = 'expired'::text) AND (activated_at IS NOT NULL) AND (expires_at IS NOT NULL) AND (blocked_at IS NULL) AND (blocked_reason_class IS NULL) AND (expired_at IS NOT NULL)))),
    CONSTRAINT continuity_delivery_grants_destination_snapshot_check CHECK (((destination_snapshot = lower(btrim(destination_snapshot))) AND (destination_snapshot !~ '[[:space:]]'::text) AND ((length(destination_snapshot) >= 3) AND (length(destination_snapshot) <= 320)))),
    CONSTRAINT continuity_delivery_grants_role_check CHECK ((role = ANY (ARRAY['beneficiary'::text, 'trustee'::text]))),
    CONSTRAINT continuity_delivery_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text, 'expired'::text])))
);


--
-- Name: continuity_delivery_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_delivery_grants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_delivery_grants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_delivery_grants_id_seq OWNED BY public.continuity_delivery_grants.id;


--
-- Name: continuity_delivery_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_delivery_items (
    id integer NOT NULL,
    delivery_grant_id integer NOT NULL,
    packet_version_id integer NOT NULL,
    packet_document_id integer NOT NULL,
    item_ordinal integer NOT NULL,
    item_kind text NOT NULL,
    eligibility_status text NOT NULL,
    blocked_reason_class text,
    document_file_id integer,
    designation_id integer,
    encryption_key_id integer,
    key_fingerprint text,
    envelope_file_key text,
    artifact_metadata jsonb,
    wrapped_dek jsonb,
    file_sha256 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_delivery_items_blocked_reason_class_check CHECK ((blocked_reason_class ~ '^[a-z0-9_]{1,80}$'::text)),
    CONSTRAINT continuity_delivery_items_check CHECK ((((eligibility_status = 'ready'::text) AND (blocked_reason_class IS NULL) AND (document_file_id IS NOT NULL) AND (designation_id IS NOT NULL) AND (encryption_key_id IS NOT NULL) AND (key_fingerprint IS NOT NULL) AND (envelope_file_key IS NOT NULL) AND (artifact_metadata IS NOT NULL) AND (wrapped_dek IS NOT NULL) AND (file_sha256 ~ '^[a-f0-9]{64}$'::text)) OR ((eligibility_status = 'blocked'::text) AND (blocked_reason_class IS NOT NULL)))),
    CONSTRAINT continuity_delivery_items_eligibility_status_check CHECK ((eligibility_status = ANY (ARRAY['ready'::text, 'blocked'::text]))),
    CONSTRAINT continuity_delivery_items_item_kind_check CHECK ((item_kind = ANY (ARRAY['letter'::text, 'selected'::text]))),
    CONSTRAINT continuity_delivery_items_item_ordinal_check CHECK ((item_ordinal > 0))
);


--
-- Name: continuity_delivery_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_delivery_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_delivery_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_delivery_items_id_seq OWNED BY public.continuity_delivery_items.id;


--
-- Name: continuity_delivery_run_trustees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_delivery_run_trustees (
    id integer NOT NULL,
    delivery_run_id integer NOT NULL,
    trustee_id integer NOT NULL,
    contact_channel_id integer NOT NULL,
    destination_snapshot text NOT NULL,
    first_successful_send_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_delivery_run_trustees_destination_snapshot_check CHECK (((destination_snapshot = lower(btrim(destination_snapshot))) AND (destination_snapshot !~ '[[:space:]]'::text) AND ((length(destination_snapshot) >= 3) AND (length(destination_snapshot) <= 320))))
);


--
-- Name: continuity_delivery_run_trustees_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_delivery_run_trustees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_delivery_run_trustees_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_delivery_run_trustees_id_seq OWNED BY public.continuity_delivery_run_trustees.id;


--
-- Name: continuity_delivery_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_delivery_runs (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    schedule_cycle bigint NOT NULL,
    packet_version_id integer NOT NULL,
    status text NOT NULL,
    trustee_window_started_at timestamp with time zone,
    trustee_action_deadline_at timestamp with time zone,
    paused_at timestamp with time zone,
    pause_deadline_at timestamp with time zone,
    released_at timestamp with time zone,
    first_grant_activated_at timestamp with time zone,
    recovered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_delivery_runs_check CHECK (((trustee_action_deadline_at IS NULL) OR (trustee_window_started_at IS NOT NULL))),
    CONSTRAINT continuity_delivery_runs_check1 CHECK (((pause_deadline_at IS NULL) OR (paused_at IS NOT NULL))),
    CONSTRAINT continuity_delivery_runs_check2 CHECK (((recovered_at IS NULL) OR (status = 'owner_recovered'::text))),
    CONSTRAINT continuity_delivery_runs_schedule_cycle_check CHECK ((schedule_cycle >= 0)),
    CONSTRAINT continuity_delivery_runs_status_check CHECK ((status = ANY (ARRAY['trustee_notification_pending'::text, 'trustee_notification_blocked'::text, 'trustee_window'::text, 'trustee_paused'::text, 'recipient_delivery'::text, 'delivery_active'::text, 'delivery_complete'::text, 'delivery_blocked'::text, 'owner_recovered'::text])))
);


--
-- Name: continuity_delivery_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_delivery_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_delivery_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_delivery_runs_id_seq OWNED BY public.continuity_delivery_runs.id;


--
-- Name: continuity_delivery_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_delivery_tokens (
    id integer NOT NULL,
    delivery_grant_id integer NOT NULL,
    purpose text DEFAULT 'access'::text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    replaced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_delivery_tokens_purpose_check CHECK ((purpose = 'access'::text)),
    CONSTRAINT continuity_delivery_tokens_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: continuity_delivery_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_delivery_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_delivery_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_delivery_tokens_id_seq OWNED BY public.continuity_delivery_tokens.id;


--
-- Name: continuity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_events (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    event_type text NOT NULL,
    actor_id integer,
    schedule_cycle bigint DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    dedupe_key text NOT NULL
);


--
-- Name: continuity_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_events_id_seq OWNED BY public.continuity_events.id;


--
-- Name: continuity_notification_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_notification_outbox (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    event_id integer,
    schedule_cycle bigint NOT NULL,
    notification_type text NOT NULL,
    recipient_email text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    message_id text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text,
    claim_expires_at timestamp with time zone,
    sent_at timestamp with time zone,
    failed_at timestamp with time zone,
    blocked_at timestamp with time zone,
    superseded_at timestamp with time zone,
    last_error_class text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_run_id integer,
    delivery_run_trustee_id integer,
    trustee_action_token_id integer,
    delivery_grant_id integer,
    delivery_token_id integer,
    CONSTRAINT continuity_notification_outbox_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT continuity_notification_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'sent'::text, 'failed'::text, 'blocked_configuration'::text, 'superseded'::text, 'deferred'::text]))),
    CONSTRAINT continuity_outbox_delivery_shape CHECK ((((notification_type = 'trustee_verification'::text) AND (delivery_run_id IS NOT NULL) AND (delivery_run_trustee_id IS NOT NULL) AND (delivery_grant_id IS NULL) AND (delivery_token_id IS NULL) AND (status <> 'deferred'::text)) OR ((notification_type = 'recipient_delivery'::text) AND (delivery_run_id IS NOT NULL) AND (delivery_run_trustee_id IS NULL) AND (trustee_action_token_id IS NULL) AND (delivery_grant_id IS NOT NULL)) OR ((notification_type <> ALL (ARRAY['trustee_verification'::text, 'recipient_delivery'::text])) AND (delivery_run_id IS NULL) AND (delivery_run_trustee_id IS NULL) AND (trustee_action_token_id IS NULL) AND (delivery_grant_id IS NULL) AND (delivery_token_id IS NULL) AND (status <> 'deferred'::text))))
);


--
-- Name: continuity_notification_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_notification_outbox_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_notification_outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_notification_outbox_id_seq OWNED BY public.continuity_notification_outbox.id;


--
-- Name: continuity_operator_channel_attestations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_operator_channel_attestations (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    owner_id integer NOT NULL,
    channel_type text NOT NULL,
    configuration_version text NOT NULL,
    target_fingerprint text NOT NULL,
    challenge_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    transport_accepted_at timestamp with time zone,
    transport_error_class text,
    acknowledged_at timestamp with time zone,
    replaced_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_operator_channel_attestatio_target_fingerprint_check CHECK ((target_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT continuity_operator_channel_attestations_attempt_count_check CHECK (((attempt_count >= 0) AND (attempt_count <= 5))),
    CONSTRAINT continuity_operator_channel_attestations_challenge_hash_check CHECK ((challenge_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT continuity_operator_channel_attestations_channel_type_check CHECK ((channel_type = ANY (ARRAY['email'::text, 'brrr'::text])))
);


--
-- Name: continuity_operator_channel_attestations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_operator_channel_attestations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_operator_channel_attestations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_operator_channel_attestations_id_seq OWNED BY public.continuity_operator_channel_attestations.id;


--
-- Name: continuity_packet_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_packet_documents (
    id integer NOT NULL,
    packet_version_id integer NOT NULL,
    document_id integer NOT NULL,
    item_kind text NOT NULL,
    packet_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_packet_documents_item_kind_check CHECK ((item_kind = ANY (ARRAY['letter'::text, 'selected'::text]))),
    CONSTRAINT continuity_packet_documents_packet_order_check CHECK ((packet_order > 0))
);


--
-- Name: continuity_packet_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_packet_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_packet_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_packet_documents_id_seq OWNED BY public.continuity_packet_documents.id;


--
-- Name: continuity_packet_recipient_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_packet_recipient_documents (
    id integer NOT NULL,
    packet_version_id integer NOT NULL,
    packet_recipient_id integer NOT NULL,
    packet_document_id integer NOT NULL,
    coverage_status text NOT NULL,
    designation_id integer,
    encryption_key_id integer,
    key_fingerprint text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_packet_recipient_documents_check CHECK ((((coverage_status = 'covered'::text) AND (designation_id IS NOT NULL) AND (encryption_key_id IS NOT NULL) AND (key_fingerprint IS NOT NULL)) OR ((coverage_status = 'not_designated'::text) AND (designation_id IS NULL) AND (encryption_key_id IS NULL) AND (key_fingerprint IS NULL)))),
    CONSTRAINT continuity_packet_recipient_documents_coverage_status_check CHECK ((coverage_status = ANY (ARRAY['covered'::text, 'not_designated'::text])))
);


--
-- Name: continuity_packet_recipient_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_packet_recipient_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_packet_recipient_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_packet_recipient_documents_id_seq OWNED BY public.continuity_packet_recipient_documents.id;


--
-- Name: continuity_packet_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_packet_recipients (
    id integer NOT NULL,
    packet_version_id integer NOT NULL,
    member_id integer,
    trustee_id integer,
    role text NOT NULL,
    packet_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_packet_recipients_check CHECK ((((role = 'beneficiary'::text) AND (member_id IS NOT NULL) AND (trustee_id IS NULL)) OR ((role = 'trustee'::text) AND (member_id IS NULL) AND (trustee_id IS NOT NULL)))),
    CONSTRAINT continuity_packet_recipients_packet_order_check CHECK ((packet_order > 0)),
    CONSTRAINT continuity_packet_recipients_role_check CHECK ((role = ANY (ARRAY['beneficiary'::text, 'trustee'::text])))
);


--
-- Name: continuity_packet_recipients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_packet_recipients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_packet_recipients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_packet_recipients_id_seq OWNED BY public.continuity_packet_recipients.id;


--
-- Name: continuity_packet_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_packet_versions (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    version_number bigint NOT NULL,
    status text DEFAULT 'staged'::text NOT NULL,
    letter_document_id integer NOT NULL,
    policy_hash text NOT NULL,
    operation_key text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    superseded_at timestamp with time zone,
    CONSTRAINT continuity_packet_versions_check CHECK ((((status = 'staged'::text) AND (activated_at IS NULL) AND (superseded_at IS NULL)) OR ((status = 'active'::text) AND (activated_at IS NOT NULL) AND (superseded_at IS NULL)) OR ((status = 'superseded'::text) AND (superseded_at IS NOT NULL)))),
    CONSTRAINT continuity_packet_versions_operation_key_check CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 120))),
    CONSTRAINT continuity_packet_versions_policy_hash_check CHECK ((policy_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT continuity_packet_versions_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'active'::text, 'superseded'::text]))),
    CONSTRAINT continuity_packet_versions_version_number_check CHECK ((version_number > 0))
);


--
-- Name: continuity_packet_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_packet_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_packet_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_packet_versions_id_seq OWNED BY public.continuity_packet_versions.id;


--
-- Name: continuity_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_recipients (
    id integer NOT NULL,
    switch_id integer NOT NULL,
    member_id integer,
    trustee_id integer,
    role text NOT NULL,
    notification_order integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_recipients_check CHECK ((((role = 'beneficiary'::text) AND (member_id IS NOT NULL) AND (trustee_id IS NULL)) OR ((role = 'trustee'::text) AND (member_id IS NULL) AND (trustee_id IS NOT NULL)))),
    CONSTRAINT continuity_recipients_notification_order_check CHECK ((notification_order > 0)),
    CONSTRAINT continuity_recipients_role_check CHECK ((role = ANY (ARRAY['beneficiary'::text, 'trustee'::text])))
);


--
-- Name: continuity_recipients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_recipients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_recipients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_recipients_id_seq OWNED BY public.continuity_recipients.id;


--
-- Name: continuity_scheduler_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_scheduler_runs (
    id integer NOT NULL,
    job_type text NOT NULL,
    status text NOT NULL,
    claimed_count integer DEFAULT 0 NOT NULL,
    transition_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    error_class text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT continuity_scheduler_runs_job_type_check CHECK ((job_type = ANY (ARRAY['state_advance'::text, 'outbox_dispatch'::text]))),
    CONSTRAINT continuity_scheduler_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: continuity_scheduler_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_scheduler_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_scheduler_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_scheduler_runs_id_seq OWNED BY public.continuity_scheduler_runs.id;


--
-- Name: continuity_switch_trustees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_switch_trustees (
    switch_id integer NOT NULL,
    trustee_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: continuity_switches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_switches (
    id integer NOT NULL,
    owner_id integer NOT NULL,
    reminder_email text NOT NULL,
    letter_document_id integer,
    staged_letter_document_id integer,
    status text DEFAULT 'draft'::text NOT NULL,
    interval_days integer NOT NULL,
    grace_period_days integer DEFAULT 14 NOT NULL,
    schedule_cycle bigint DEFAULT 0 NOT NULL,
    last_checkin_at timestamp with time zone,
    next_checkin_due_at timestamp with time zone,
    delivery_pending_at timestamp with time zone,
    paused_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    staged_packet_version_id integer,
    active_packet_version_id integer,
    CONSTRAINT continuity_switch_packet_pointer_check CHECK (((staged_packet_version_id IS NULL) OR (staged_packet_version_id <> active_packet_version_id))),
    CONSTRAINT continuity_switches_check CHECK (((grace_period_days >= 7) AND (grace_period_days < interval_days))),
    CONSTRAINT continuity_switches_check1 CHECK (((letter_document_id IS NULL) OR (letter_document_id <> staged_letter_document_id))),
    CONSTRAINT continuity_switches_interval_days_check CHECK ((interval_days = ANY (ARRAY[30, 90, 180]))),
    CONSTRAINT continuity_switches_schedule_cycle_check CHECK ((schedule_cycle >= 0)),
    CONSTRAINT continuity_switches_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'armed'::text, 'paused'::text, 'delivery_pending'::text, 'trustee_notification_pending'::text, 'trustee_notification_blocked'::text, 'trustee_window'::text, 'trustee_paused'::text, 'recipient_delivery'::text, 'delivery_active'::text, 'delivery_complete'::text, 'delivery_blocked'::text, 'cancelled'::text])))
);


--
-- Name: continuity_switches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_switches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_switches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_switches_id_seq OWNED BY public.continuity_switches.id;


--
-- Name: continuity_trustee_action_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continuity_trustee_action_tokens (
    id integer NOT NULL,
    delivery_run_id integer NOT NULL,
    delivery_run_trustee_id integer NOT NULL,
    purpose text DEFAULT 'pause'::text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    replaced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT continuity_trustee_action_tokens_purpose_check CHECK ((purpose = 'pause'::text)),
    CONSTRAINT continuity_trustee_action_tokens_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: continuity_trustee_action_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continuity_trustee_action_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continuity_trustee_action_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continuity_trustee_action_tokens_id_seq OWNED BY public.continuity_trustee_action_tokens.id;


--
-- Name: document_designations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_designations (
    id integer NOT NULL,
    document_id integer NOT NULL,
    member_id integer,
    trustee_id integer,
    role text NOT NULL,
    sealed boolean DEFAULT true NOT NULL,
    sealed_until text DEFAULT 'deadman_trigger'::text NOT NULL,
    encryption_key_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_designations_check CHECK ((((role = 'beneficiary'::text) AND (member_id IS NOT NULL) AND (trustee_id IS NULL)) OR ((role = 'trustee'::text) AND (member_id IS NULL) AND (trustee_id IS NOT NULL)))),
    CONSTRAINT document_designations_role_check CHECK ((role = ANY (ARRAY['beneficiary'::text, 'trustee'::text])))
);


--
-- Name: document_designations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_designations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_designations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_designations_id_seq OWNED BY public.document_designations.id;


--
-- Name: document_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_files (
    id integer NOT NULL,
    document_id integer NOT NULL,
    file_type text NOT NULL,
    stored_filename text NOT NULL,
    original_filename text NOT NULL,
    mime_type text NOT NULL,
    file_size_bytes bigint NOT NULL,
    page_count integer,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sha256 text,
    CONSTRAINT document_files_file_type_check CHECK ((file_type = ANY (ARRAY['original'::text, 'processed'::text, 'thumbnail'::text])))
);


--
-- Name: document_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_files_id_seq OWNED BY public.document_files.id;


--
-- Name: document_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_owners (
    id integer NOT NULL,
    document_id integer NOT NULL,
    member_id integer NOT NULL,
    ownership_type text DEFAULT 'owner'::text NOT NULL,
    CONSTRAINT document_owners_ownership_type_check CHECK ((ownership_type = ANY (ARRAY['owner'::text, 'joint'::text, 'beneficiary'::text, 'custodian'::text])))
);


--
-- Name: document_owners_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.document_owners_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_owners_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.document_owners_id_seq OWNED BY public.document_owners.id;


--
-- Name: document_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_tags (
    document_id integer NOT NULL,
    tag_id integer NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    document_type text NOT NULL,
    source_type text NOT NULL,
    source_url text,
    status text DEFAULT 'active'::text NOT NULL,
    issued_date date,
    expiry_date date,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    search_vector tsvector,
    encryption_key_id integer,
    is_encrypted boolean DEFAULT false NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    encryption_mode text DEFAULT 'plaintext'::text NOT NULL,
    encryption_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT documents_document_type_check CHECK ((document_type = ANY (ARRAY['warranty'::text, 'insurance'::text, 'certificate'::text, 'manual'::text, 'receipt'::text, 'contract'::text, 'medical'::text, 'legal'::text, 'tax'::text, 'identification'::text, 'property'::text, 'vehicle'::text, 'notice'::text, 'employment'::text, 'other'::text]))),
    CONSTRAINT documents_encryption_mode_check CHECK ((encryption_mode = ANY (ARRAY['plaintext'::text, 'passphrase'::text, 'timelock'::text, 'pki'::text]))),
    CONSTRAINT documents_source_type_check CHECK ((source_type = ANY (ARRAY['scan'::text, 'upload'::text, 'url_import'::text, 'authored'::text]))),
    CONSTRAINT documents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text, 'staged'::text])))
);


--
-- Name: documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.documents_id_seq OWNED BY public.documents.id;


--
-- Name: encryption_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encryption_keys (
    id integer NOT NULL,
    key_type text NOT NULL,
    public_key text,
    encrypted_private_key text,
    algorithm text DEFAULT 'aes-256-gcm'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    member_id integer,
    credential_id text,
    prf_enabled boolean DEFAULT false NOT NULL,
    key_fingerprint text,
    protection_tier text DEFAULT 'passphrase'::text NOT NULL,
    label text,
    last_used_at timestamp with time zone,
    credential_verified boolean DEFAULT false NOT NULL,
    verification_method text DEFAULT 'manual'::text NOT NULL,
    credential_transports jsonb DEFAULT '[]'::jsonb NOT NULL,
    credential_device_type text,
    credential_backed_up boolean,
    credential_attachment text,
    verified_at timestamp with time zone,
    recovery_wrapped_private_key text,
    recovery_type text,
    trustee_id integer,
    CONSTRAINT encryption_keys_credential_attachment_check CHECK ((credential_attachment = ANY (ARRAY['platform'::text, 'cross-platform'::text]))),
    CONSTRAINT encryption_keys_credential_device_type_check CHECK ((credential_device_type = ANY (ARRAY['singleDevice'::text, 'multiDevice'::text]))),
    CONSTRAINT encryption_keys_key_type_check CHECK ((key_type = ANY (ARRAY['document'::text, 'member'::text, 'recovery'::text, 'trustee'::text]))),
    CONSTRAINT encryption_keys_principal_check CHECK ((((key_type = 'member'::text) AND (member_id IS NOT NULL) AND (trustee_id IS NULL)) OR ((key_type = 'trustee'::text) AND (member_id IS NULL) AND (trustee_id IS NOT NULL)) OR ((key_type = ANY (ARRAY['document'::text, 'recovery'::text])) AND (trustee_id IS NULL)))),
    CONSTRAINT encryption_keys_protection_tier_check CHECK ((protection_tier = ANY (ARRAY['hardware'::text, 'platform'::text, 'passphrase'::text]))),
    CONSTRAINT encryption_keys_recovery_type_check CHECK ((recovery_type = 'mnemonic_bip39'::text)),
    CONSTRAINT encryption_keys_verification_method_check CHECK ((verification_method = ANY (ARRAY['manual'::text, 'webauthn'::text, 'passphrase'::text])))
);


--
-- Name: encryption_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.encryption_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: encryption_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.encryption_keys_id_seq OWNED BY public.encryption_keys.id;


--
-- Name: family_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_members (
    id integer NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    avatar_emoji text DEFAULT '👤'::text NOT NULL,
    color text,
    passphrase_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_members_role_check CHECK ((role = ANY (ARRAY['parent'::text, 'kid'::text])))
);


--
-- Name: family_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.family_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: family_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.family_members_id_seq OWNED BY public.family_members.id;


--
-- Name: import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_batches (
    id integer NOT NULL,
    name text NOT NULL,
    source_kind text NOT NULL,
    source_label text,
    status text DEFAULT 'queued'::text NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_batches_source_kind_check CHECK ((source_kind = ANY (ARRAY['browser_files'::text, 'browser_directory'::text, 'server_folder'::text, 'url_list'::text]))),
    CONSTRAINT import_batches_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'completed'::text, 'completed_with_errors'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: import_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_batches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_batches_id_seq OWNED BY public.import_batches.id;


--
-- Name: import_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_items (
    id integer NOT NULL,
    batch_id integer NOT NULL,
    document_id integer,
    original_filename text NOT NULL,
    relative_path text,
    source_uri text,
    mime_type text,
    file_size_bytes bigint,
    sha256 text,
    status text DEFAULT 'staged'::text NOT NULL,
    error_message text,
    magicindex_result jsonb,
    magicindex_confidence numeric(4,3),
    retry_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_items_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'queued'::text, 'stored'::text, 'thumbnail_pending'::text, 'thumbnail_done'::text, 'magicindex_pending'::text, 'magicindex_done'::text, 'review_ready'::text, 'imported'::text, 'skipped_duplicate'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: import_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_items_id_seq OWNED BY public.import_items.id;


--
-- Name: magic_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.magic_data (
    id integer NOT NULL,
    category text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    subject_type text NOT NULL,
    subject_id integer,
    dedupe_key text NOT NULL,
    title text NOT NULL,
    body jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence numeric(4,3),
    source_document_ids integer[] DEFAULT '{}'::integer[] NOT NULL,
    reasoning text,
    status text DEFAULT 'new'::text NOT NULL,
    action_url text,
    due_date date,
    expires_at timestamp with time zone,
    scan_id text,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT magic_data_category_check CHECK ((category = ANY (ARRAY['expiry_alert'::text, 'renewal_reminder'::text, 'document_quality'::text, 'household_insight'::text]))),
    CONSTRAINT magic_data_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT magic_data_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))),
    CONSTRAINT magic_data_status_check CHECK ((status = ANY (ARRAY['new'::text, 'accepted'::text, 'dismissed'::text, 'stale'::text, 'resolved'::text]))),
    CONSTRAINT magic_data_subject_type_check CHECK ((subject_type = ANY (ARRAY['document'::text, 'member'::text, 'household'::text])))
);


--
-- Name: magic_data_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.magic_data_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: magic_data_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.magic_data_id_seq OWNED BY public.magic_data.id;


--
-- Name: magic_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.magic_links (
    id integer NOT NULL,
    source_document_id integer NOT NULL,
    target_document_id integer NOT NULL,
    link_type text NOT NULL,
    reasoning text NOT NULL,
    confidence numeric(4,3) NOT NULL,
    created_by text DEFAULT 'agent'::text NOT NULL,
    status text DEFAULT 'suggested'::text NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT magic_links_check CHECK ((source_document_id <> target_document_id)),
    CONSTRAINT magic_links_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT magic_links_created_by_check CHECK ((created_by = ANY (ARRAY['agent'::text, 'user'::text]))),
    CONSTRAINT magic_links_link_type_check CHECK ((link_type = ANY (ARRAY['relates_to'::text, 'supersedes'::text, 'renews'::text, 'supplements'::text, 'same_asset'::text, 'same_provider'::text, 'same_account'::text]))),
    CONSTRAINT magic_links_status_check CHECK ((status = ANY (ARRAY['suggested'::text, 'accepted'::text, 'dismissed'::text])))
);


--
-- Name: magic_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.magic_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: magic_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.magic_links_id_seq OWNED BY public.magic_links.id;


--
-- Name: member_contact_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_contact_channels (
    id integer NOT NULL,
    member_id integer NOT NULL,
    channel_type text NOT NULL,
    normalized_address text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by integer NOT NULL,
    verified_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_contact_channels_channel_type_check CHECK ((channel_type = 'email'::text)),
    CONSTRAINT member_contact_channels_check CHECK ((((status = 'pending'::text) AND (verified_at IS NULL) AND (revoked_at IS NULL)) OR ((status = 'verified'::text) AND (verified_at IS NOT NULL) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT member_contact_channels_normalized_address_check CHECK (((normalized_address = lower(btrim(normalized_address))) AND (normalized_address !~ '[[:space:]]'::text) AND ((length(normalized_address) >= 3) AND (length(normalized_address) <= 320)))),
    CONSTRAINT member_contact_channels_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'revoked'::text])))
);


--
-- Name: member_contact_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.member_contact_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: member_contact_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.member_contact_channels_id_seq OWNED BY public.member_contact_channels.id;


--
-- Name: member_contact_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_contact_verification_tokens (
    id integer NOT NULL,
    contact_channel_id integer NOT NULL,
    purpose text DEFAULT 'email_control'::text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    replaced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_contact_verification_tokens_purpose_check CHECK ((purpose = 'email_control'::text)),
    CONSTRAINT member_contact_verification_tokens_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: member_contact_verification_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.member_contact_verification_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: member_contact_verification_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.member_contact_verification_tokens_id_seq OWNED BY public.member_contact_verification_tokens.id;


--
-- Name: member_notification_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_notification_channels (
    id integer NOT NULL,
    member_id integer NOT NULL,
    channel_type text NOT NULL,
    label text,
    target_secret text,
    target_fingerprint text,
    enabled boolean DEFAULT false NOT NULL,
    config_version bigint DEFAULT 1 NOT NULL,
    transport_tested_at timestamp with time zone,
    last_transport_status text,
    last_transport_error_class text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_notification_channels_channel_type_check CHECK ((channel_type = 'brrr'::text)),
    CONSTRAINT member_notification_channels_check CHECK (((NOT enabled) OR ((target_secret IS NOT NULL) AND (target_fingerprint IS NOT NULL)))),
    CONSTRAINT member_notification_channels_config_version_check CHECK ((config_version > 0)),
    CONSTRAINT member_notification_channels_last_transport_status_check CHECK ((last_transport_status = ANY (ARRAY['accepted'::text, 'failed'::text]))),
    CONSTRAINT member_notification_channels_target_fingerprint_check CHECK (((target_fingerprint IS NULL) OR (target_fingerprint ~ '^[a-f0-9]{64}$'::text)))
);


--
-- Name: member_notification_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.member_notification_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: member_notification_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.member_notification_channels_id_seq OWNED BY public.member_notification_channels.id;


--
-- Name: processing_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processing_jobs (
    id integer NOT NULL,
    job_type text NOT NULL,
    import_item_id integer,
    document_id integer,
    status text DEFAULT 'queued'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT processing_jobs_job_type_check CHECK ((job_type = ANY (ARRAY['store_import_item'::text, 'thumbnail'::text, 'magicindex'::text]))),
    CONSTRAINT processing_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: processing_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.processing_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: processing_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.processing_jobs_id_seq OWNED BY public.processing_jobs.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id integer NOT NULL,
    token text NOT NULL,
    member_id integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;


--
-- Name: share_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.share_links (
    id integer NOT NULL,
    document_id integer NOT NULL,
    token text NOT NULL,
    created_by integer NOT NULL,
    access_level text DEFAULT 'view'::text NOT NULL,
    pin_hash text,
    expires_at timestamp with time zone,
    max_uses integer,
    use_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT share_links_access_level_check CHECK ((access_level = ANY (ARRAY['view'::text, 'download'::text])))
);


--
-- Name: share_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.share_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: share_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.share_links_id_seq OWNED BY public.share_links.id;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id integer NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6b7280'::text NOT NULL
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: trustee_contact_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trustee_contact_channels (
    id integer NOT NULL,
    trustee_id integer NOT NULL,
    channel_type text NOT NULL,
    normalized_address text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    verification_source text,
    verified_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trustee_contact_channels_channel_type_check CHECK ((channel_type = 'email'::text)),
    CONSTRAINT trustee_contact_channels_check CHECK ((((status = 'pending'::text) AND (verified_at IS NULL) AND (revoked_at IS NULL)) OR ((status = 'verified'::text) AND (verified_at IS NOT NULL) AND (revoked_at IS NULL) AND (verification_source IS NOT NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT trustee_contact_channels_normalized_address_check CHECK (((normalized_address = lower(btrim(normalized_address))) AND (normalized_address !~ '[[:space:]]'::text) AND ((length(normalized_address) >= 3) AND (length(normalized_address) <= 320)))),
    CONSTRAINT trustee_contact_channels_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'revoked'::text]))),
    CONSTRAINT trustee_contact_channels_verification_source_check CHECK ((verification_source = ANY (ARRAY['trustee_registration'::text, 'contact_verification'::text])))
);


--
-- Name: trustee_contact_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trustee_contact_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trustee_contact_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trustee_contact_channels_id_seq OWNED BY public.trustee_contact_channels.id;


--
-- Name: trustee_contact_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trustee_contact_verification_tokens (
    id integer NOT NULL,
    contact_channel_id integer NOT NULL,
    purpose text DEFAULT 'email_control'::text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    replaced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trustee_contact_verification_tokens_purpose_check CHECK ((purpose = 'email_control'::text)),
    CONSTRAINT trustee_contact_verification_tokens_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: trustee_contact_verification_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trustee_contact_verification_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trustee_contact_verification_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trustee_contact_verification_tokens_id_seq OWNED BY public.trustee_contact_verification_tokens.id;


--
-- Name: trustee_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trustee_invitations (
    id integer NOT NULL,
    trustee_id integer NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trustee_invitations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trustee_invitations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trustee_invitations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trustee_invitations_id_seq OWNED BY public.trustee_invitations.id;


--
-- Name: vault_trustees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_trustees (
    id integer NOT NULL,
    name text NOT NULL,
    relationship text,
    email text NOT NULL,
    status text DEFAULT 'invited'::text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    registered_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT vault_trustees_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'registered'::text, 'revoked'::text])))
);


--
-- Name: vault_trustees_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vault_trustees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vault_trustees_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vault_trustees_id_seq OWNED BY public.vault_trustees.id;


--
-- Name: webauthn_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webauthn_challenges (
    id integer NOT NULL,
    member_id integer,
    purpose text NOT NULL,
    challenge text NOT NULL,
    rp_id text NOT NULL,
    expected_origin text NOT NULL,
    prf_salt text,
    requested_method text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    trustee_id integer,
    CONSTRAINT webauthn_challenges_principal_check CHECK ((((member_id IS NOT NULL) AND (trustee_id IS NULL)) OR ((member_id IS NULL) AND (trustee_id IS NOT NULL)))),
    CONSTRAINT webauthn_challenges_purpose_check CHECK ((purpose = ANY (ARRAY['member_key_registration'::text, 'member_key_assertion'::text, 'trustee_key_registration'::text, 'trustee_key_assertion'::text]))),
    CONSTRAINT webauthn_challenges_requested_method_check CHECK ((requested_method = ANY (ARRAY['security_key'::text, 'passkey'::text])))
);


--
-- Name: webauthn_challenges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.webauthn_challenges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: webauthn_challenges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.webauthn_challenges_id_seq OWNED BY public.webauthn_challenges.id;


--
-- Name: webauthn_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webauthn_credentials (
    id integer NOT NULL,
    member_id integer,
    credential_id text NOT NULL,
    credential_public_key text NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    credential_device_type text NOT NULL,
    credential_backed_up boolean DEFAULT false NOT NULL,
    credential_attachment text,
    credential_transports jsonb DEFAULT '[]'::jsonb NOT NULL,
    requested_method text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    registration_prf_salt text,
    trustee_id integer,
    CONSTRAINT webauthn_credentials_credential_attachment_check CHECK ((credential_attachment = ANY (ARRAY['platform'::text, 'cross-platform'::text]))),
    CONSTRAINT webauthn_credentials_credential_device_type_check CHECK ((credential_device_type = ANY (ARRAY['singleDevice'::text, 'multiDevice'::text]))),
    CONSTRAINT webauthn_credentials_principal_check CHECK ((((member_id IS NOT NULL) AND (trustee_id IS NULL)) OR ((member_id IS NULL) AND (trustee_id IS NOT NULL)))),
    CONSTRAINT webauthn_credentials_requested_method_check CHECK ((requested_method = ANY (ARRAY['security_key'::text, 'passkey'::text])))
);


--
-- Name: webauthn_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.webauthn_credentials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: webauthn_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.webauthn_credentials_id_seq OWNED BY public.webauthn_credentials.id;


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: backup_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_log ALTER COLUMN id SET DEFAULT nextval('public.backup_log_id_seq'::regclass);


--
-- Name: continuity_brrr_outbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_brrr_outbox ALTER COLUMN id SET DEFAULT nextval('public.continuity_brrr_outbox_id_seq'::regclass);


--
-- Name: continuity_checkin_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_checkin_tokens ALTER COLUMN id SET DEFAULT nextval('public.continuity_checkin_tokens_id_seq'::regclass);


--
-- Name: continuity_delivery_grants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants ALTER COLUMN id SET DEFAULT nextval('public.continuity_delivery_grants_id_seq'::regclass);


--
-- Name: continuity_delivery_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items ALTER COLUMN id SET DEFAULT nextval('public.continuity_delivery_items_id_seq'::regclass);


--
-- Name: continuity_delivery_run_trustees id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_run_trustees ALTER COLUMN id SET DEFAULT nextval('public.continuity_delivery_run_trustees_id_seq'::regclass);


--
-- Name: continuity_delivery_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_runs ALTER COLUMN id SET DEFAULT nextval('public.continuity_delivery_runs_id_seq'::regclass);


--
-- Name: continuity_delivery_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_tokens ALTER COLUMN id SET DEFAULT nextval('public.continuity_delivery_tokens_id_seq'::regclass);


--
-- Name: continuity_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_events ALTER COLUMN id SET DEFAULT nextval('public.continuity_events_id_seq'::regclass);


--
-- Name: continuity_notification_outbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox ALTER COLUMN id SET DEFAULT nextval('public.continuity_notification_outbox_id_seq'::regclass);


--
-- Name: continuity_operator_channel_attestations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_operator_channel_attestations ALTER COLUMN id SET DEFAULT nextval('public.continuity_operator_channel_attestations_id_seq'::regclass);


--
-- Name: continuity_packet_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_documents ALTER COLUMN id SET DEFAULT nextval('public.continuity_packet_documents_id_seq'::regclass);


--
-- Name: continuity_packet_recipient_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents ALTER COLUMN id SET DEFAULT nextval('public.continuity_packet_recipient_documents_id_seq'::regclass);


--
-- Name: continuity_packet_recipients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipients ALTER COLUMN id SET DEFAULT nextval('public.continuity_packet_recipients_id_seq'::regclass);


--
-- Name: continuity_packet_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_versions ALTER COLUMN id SET DEFAULT nextval('public.continuity_packet_versions_id_seq'::regclass);


--
-- Name: continuity_recipients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_recipients ALTER COLUMN id SET DEFAULT nextval('public.continuity_recipients_id_seq'::regclass);


--
-- Name: continuity_scheduler_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_scheduler_runs ALTER COLUMN id SET DEFAULT nextval('public.continuity_scheduler_runs_id_seq'::regclass);


--
-- Name: continuity_switches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switches ALTER COLUMN id SET DEFAULT nextval('public.continuity_switches_id_seq'::regclass);


--
-- Name: continuity_trustee_action_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_trustee_action_tokens ALTER COLUMN id SET DEFAULT nextval('public.continuity_trustee_action_tokens_id_seq'::regclass);


--
-- Name: document_designations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_designations ALTER COLUMN id SET DEFAULT nextval('public.document_designations_id_seq'::regclass);


--
-- Name: document_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_files ALTER COLUMN id SET DEFAULT nextval('public.document_files_id_seq'::regclass);


--
-- Name: document_owners id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_owners ALTER COLUMN id SET DEFAULT nextval('public.document_owners_id_seq'::regclass);


--
-- Name: documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents ALTER COLUMN id SET DEFAULT nextval('public.documents_id_seq'::regclass);


--
-- Name: encryption_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_keys ALTER COLUMN id SET DEFAULT nextval('public.encryption_keys_id_seq'::regclass);


--
-- Name: family_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members ALTER COLUMN id SET DEFAULT nextval('public.family_members_id_seq'::regclass);


--
-- Name: import_batches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches ALTER COLUMN id SET DEFAULT nextval('public.import_batches_id_seq'::regclass);


--
-- Name: import_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_items ALTER COLUMN id SET DEFAULT nextval('public.import_items_id_seq'::regclass);


--
-- Name: magic_data id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_data ALTER COLUMN id SET DEFAULT nextval('public.magic_data_id_seq'::regclass);


--
-- Name: magic_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links ALTER COLUMN id SET DEFAULT nextval('public.magic_links_id_seq'::regclass);


--
-- Name: member_contact_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_channels ALTER COLUMN id SET DEFAULT nextval('public.member_contact_channels_id_seq'::regclass);


--
-- Name: member_contact_verification_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_verification_tokens ALTER COLUMN id SET DEFAULT nextval('public.member_contact_verification_tokens_id_seq'::regclass);


--
-- Name: member_notification_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notification_channels ALTER COLUMN id SET DEFAULT nextval('public.member_notification_channels_id_seq'::regclass);


--
-- Name: processing_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_jobs ALTER COLUMN id SET DEFAULT nextval('public.processing_jobs_id_seq'::regclass);


--
-- Name: sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);


--
-- Name: share_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links ALTER COLUMN id SET DEFAULT nextval('public.share_links_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: trustee_contact_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_contact_channels ALTER COLUMN id SET DEFAULT nextval('public.trustee_contact_channels_id_seq'::regclass);


--
-- Name: trustee_contact_verification_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_contact_verification_tokens ALTER COLUMN id SET DEFAULT nextval('public.trustee_contact_verification_tokens_id_seq'::regclass);


--
-- Name: trustee_invitations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_invitations ALTER COLUMN id SET DEFAULT nextval('public.trustee_invitations_id_seq'::regclass);


--
-- Name: vault_trustees id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_trustees ALTER COLUMN id SET DEFAULT nextval('public.vault_trustees_id_seq'::regclass);


--
-- Name: webauthn_challenges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_challenges ALTER COLUMN id SET DEFAULT nextval('public.webauthn_challenges_id_seq'::regclass);


--
-- Name: webauthn_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials ALTER COLUMN id SET DEFAULT nextval('public.webauthn_credentials_id_seq'::regclass);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: backup_log backup_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_log
    ADD CONSTRAINT backup_log_pkey PRIMARY KEY (id);


--
-- Name: continuity_brrr_outbox continuity_brrr_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_brrr_outbox
    ADD CONSTRAINT continuity_brrr_outbox_pkey PRIMARY KEY (id);


--
-- Name: continuity_brrr_outbox continuity_brrr_outbox_switch_id_schedule_cycle_notificatio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_brrr_outbox
    ADD CONSTRAINT continuity_brrr_outbox_switch_id_schedule_cycle_notificatio_key UNIQUE (switch_id, schedule_cycle, notification_type, notification_channel_id);


--
-- Name: continuity_checkin_tokens continuity_checkin_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_checkin_tokens
    ADD CONSTRAINT continuity_checkin_tokens_pkey PRIMARY KEY (id);


--
-- Name: continuity_checkin_tokens continuity_checkin_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_checkin_tokens
    ADD CONSTRAINT continuity_checkin_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: continuity_delivery_grants continuity_delivery_grants_delivery_run_id_packet_recipient_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_delivery_run_id_packet_recipient_key UNIQUE (delivery_run_id, packet_recipient_id);


--
-- Name: continuity_delivery_grants continuity_delivery_grants_id_delivery_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_id_delivery_run_id_key UNIQUE (id, delivery_run_id);


--
-- Name: continuity_delivery_grants continuity_delivery_grants_id_packet_version_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_id_packet_version_id_key UNIQUE (id, packet_version_id);


--
-- Name: continuity_delivery_grants continuity_delivery_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_pkey PRIMARY KEY (id);


--
-- Name: continuity_delivery_items continuity_delivery_items_delivery_grant_id_item_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_delivery_grant_id_item_ordinal_key UNIQUE (delivery_grant_id, item_ordinal);


--
-- Name: continuity_delivery_items continuity_delivery_items_delivery_grant_id_packet_document_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_delivery_grant_id_packet_document_key UNIQUE (delivery_grant_id, packet_document_id);


--
-- Name: continuity_delivery_items continuity_delivery_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_pkey PRIMARY KEY (id);


--
-- Name: continuity_delivery_run_trustees continuity_delivery_run_trustees_delivery_run_id_trustee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_run_trustees
    ADD CONSTRAINT continuity_delivery_run_trustees_delivery_run_id_trustee_id_key UNIQUE (delivery_run_id, trustee_id);


--
-- Name: continuity_delivery_run_trustees continuity_delivery_run_trustees_id_delivery_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_run_trustees
    ADD CONSTRAINT continuity_delivery_run_trustees_id_delivery_run_id_key UNIQUE (id, delivery_run_id);


--
-- Name: continuity_delivery_run_trustees continuity_delivery_run_trustees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_run_trustees
    ADD CONSTRAINT continuity_delivery_run_trustees_pkey PRIMARY KEY (id);


--
-- Name: continuity_delivery_runs continuity_delivery_runs_id_packet_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_runs
    ADD CONSTRAINT continuity_delivery_runs_id_packet_unique UNIQUE (id, packet_version_id);


--
-- Name: continuity_delivery_runs continuity_delivery_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_runs
    ADD CONSTRAINT continuity_delivery_runs_pkey PRIMARY KEY (id);


--
-- Name: continuity_delivery_runs continuity_delivery_runs_switch_id_schedule_cycle_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_runs
    ADD CONSTRAINT continuity_delivery_runs_switch_id_schedule_cycle_key UNIQUE (switch_id, schedule_cycle);


--
-- Name: continuity_delivery_tokens continuity_delivery_tokens_id_delivery_grant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_tokens
    ADD CONSTRAINT continuity_delivery_tokens_id_delivery_grant_id_key UNIQUE (id, delivery_grant_id);


--
-- Name: continuity_delivery_tokens continuity_delivery_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_tokens
    ADD CONSTRAINT continuity_delivery_tokens_pkey PRIMARY KEY (id);


--
-- Name: continuity_delivery_tokens continuity_delivery_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_tokens
    ADD CONSTRAINT continuity_delivery_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: continuity_events continuity_events_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_events
    ADD CONSTRAINT continuity_events_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: continuity_events continuity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_events
    ADD CONSTRAINT continuity_events_pkey PRIMARY KEY (id);


--
-- Name: continuity_notification_outbox continuity_notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: continuity_operator_channel_attestations continuity_operator_channel_attestations_challenge_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_operator_channel_attestations
    ADD CONSTRAINT continuity_operator_channel_attestations_challenge_hash_key UNIQUE (challenge_hash);


--
-- Name: continuity_operator_channel_attestations continuity_operator_channel_attestations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_operator_channel_attestations
    ADD CONSTRAINT continuity_operator_channel_attestations_pkey PRIMARY KEY (id);


--
-- Name: continuity_packet_documents continuity_packet_documents_id_packet_version_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_documents
    ADD CONSTRAINT continuity_packet_documents_id_packet_version_id_key UNIQUE (id, packet_version_id);


--
-- Name: continuity_packet_documents continuity_packet_documents_packet_version_id_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_documents
    ADD CONSTRAINT continuity_packet_documents_packet_version_id_document_id_key UNIQUE (packet_version_id, document_id);


--
-- Name: continuity_packet_documents continuity_packet_documents_packet_version_id_packet_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_documents
    ADD CONSTRAINT continuity_packet_documents_packet_version_id_packet_order_key UNIQUE (packet_version_id, packet_order);


--
-- Name: continuity_packet_documents continuity_packet_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_documents
    ADD CONSTRAINT continuity_packet_documents_pkey PRIMARY KEY (id);


--
-- Name: continuity_packet_recipient_documents continuity_packet_recipient_d_packet_recipient_id_packet_do_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents
    ADD CONSTRAINT continuity_packet_recipient_d_packet_recipient_id_packet_do_key UNIQUE (packet_recipient_id, packet_document_id);


--
-- Name: continuity_packet_recipient_documents continuity_packet_recipient_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents
    ADD CONSTRAINT continuity_packet_recipient_documents_pkey PRIMARY KEY (id);


--
-- Name: continuity_packet_recipients continuity_packet_recipients_id_packet_version_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipients
    ADD CONSTRAINT continuity_packet_recipients_id_packet_version_id_key UNIQUE (id, packet_version_id);


--
-- Name: continuity_packet_recipients continuity_packet_recipients_packet_version_id_packet_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipients
    ADD CONSTRAINT continuity_packet_recipients_packet_version_id_packet_order_key UNIQUE (packet_version_id, packet_order);


--
-- Name: continuity_packet_recipients continuity_packet_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipients
    ADD CONSTRAINT continuity_packet_recipients_pkey PRIMARY KEY (id);


--
-- Name: continuity_packet_versions continuity_packet_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_versions
    ADD CONSTRAINT continuity_packet_versions_pkey PRIMARY KEY (id);


--
-- Name: continuity_packet_versions continuity_packet_versions_switch_id_operation_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_versions
    ADD CONSTRAINT continuity_packet_versions_switch_id_operation_key_key UNIQUE (switch_id, operation_key);


--
-- Name: continuity_packet_versions continuity_packet_versions_switch_id_version_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_versions
    ADD CONSTRAINT continuity_packet_versions_switch_id_version_number_key UNIQUE (switch_id, version_number);


--
-- Name: continuity_recipients continuity_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_recipients
    ADD CONSTRAINT continuity_recipients_pkey PRIMARY KEY (id);


--
-- Name: continuity_scheduler_runs continuity_scheduler_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_scheduler_runs
    ADD CONSTRAINT continuity_scheduler_runs_pkey PRIMARY KEY (id);


--
-- Name: continuity_switch_trustees continuity_switch_trustees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switch_trustees
    ADD CONSTRAINT continuity_switch_trustees_pkey PRIMARY KEY (switch_id, trustee_id);


--
-- Name: continuity_switches continuity_switches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switches
    ADD CONSTRAINT continuity_switches_pkey PRIMARY KEY (id);


--
-- Name: continuity_trustee_action_tokens continuity_trustee_action_tok_id_delivery_run_id_delivery_r_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_trustee_action_tokens
    ADD CONSTRAINT continuity_trustee_action_tok_id_delivery_run_id_delivery_r_key UNIQUE (id, delivery_run_id, delivery_run_trustee_id);


--
-- Name: continuity_trustee_action_tokens continuity_trustee_action_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_trustee_action_tokens
    ADD CONSTRAINT continuity_trustee_action_tokens_pkey PRIMARY KEY (id);


--
-- Name: continuity_trustee_action_tokens continuity_trustee_action_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_trustee_action_tokens
    ADD CONSTRAINT continuity_trustee_action_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: document_designations document_designations_document_id_encryption_key_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_designations
    ADD CONSTRAINT document_designations_document_id_encryption_key_id_key UNIQUE (document_id, encryption_key_id);


--
-- Name: document_designations document_designations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_designations
    ADD CONSTRAINT document_designations_pkey PRIMARY KEY (id);


--
-- Name: document_files document_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_files
    ADD CONSTRAINT document_files_pkey PRIMARY KEY (id);


--
-- Name: document_owners document_owners_document_id_member_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_owners
    ADD CONSTRAINT document_owners_document_id_member_id_key UNIQUE (document_id, member_id);


--
-- Name: document_owners document_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_owners
    ADD CONSTRAINT document_owners_pkey PRIMARY KEY (id);


--
-- Name: document_tags document_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_pkey PRIMARY KEY (document_id, tag_id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: encryption_keys encryption_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_keys
    ADD CONSTRAINT encryption_keys_pkey PRIMARY KEY (id);


--
-- Name: family_members family_members_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_name_key UNIQUE (name);


--
-- Name: family_members family_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_pkey PRIMARY KEY (id);


--
-- Name: import_batches import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);


--
-- Name: import_items import_items_batch_id_relative_path_original_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_items
    ADD CONSTRAINT import_items_batch_id_relative_path_original_filename_key UNIQUE (batch_id, relative_path, original_filename);


--
-- Name: import_items import_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_items
    ADD CONSTRAINT import_items_pkey PRIMARY KEY (id);


--
-- Name: magic_data magic_data_category_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_data
    ADD CONSTRAINT magic_data_category_dedupe_key_key UNIQUE (category, dedupe_key);


--
-- Name: magic_data magic_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_data
    ADD CONSTRAINT magic_data_pkey PRIMARY KEY (id);


--
-- Name: magic_links magic_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_pkey PRIMARY KEY (id);


--
-- Name: magic_links magic_links_source_document_id_target_document_id_link_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_source_document_id_target_document_id_link_type_key UNIQUE (source_document_id, target_document_id, link_type);


--
-- Name: member_contact_channels member_contact_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_channels
    ADD CONSTRAINT member_contact_channels_pkey PRIMARY KEY (id);


--
-- Name: member_contact_verification_tokens member_contact_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_verification_tokens
    ADD CONSTRAINT member_contact_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: member_contact_verification_tokens member_contact_verification_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_verification_tokens
    ADD CONSTRAINT member_contact_verification_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: member_notification_channels member_notification_channels_member_id_channel_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notification_channels
    ADD CONSTRAINT member_notification_channels_member_id_channel_type_key UNIQUE (member_id, channel_type);


--
-- Name: member_notification_channels member_notification_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notification_channels
    ADD CONSTRAINT member_notification_channels_pkey PRIMARY KEY (id);


--
-- Name: processing_jobs processing_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_jobs
    ADD CONSTRAINT processing_jobs_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_key UNIQUE (token);


--
-- Name: share_links share_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_pkey PRIMARY KEY (id);


--
-- Name: share_links share_links_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_token_key UNIQUE (token);


--
-- Name: tags tags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: trustee_contact_channels trustee_contact_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_contact_channels
    ADD CONSTRAINT trustee_contact_channels_pkey PRIMARY KEY (id);


--
-- Name: trustee_contact_verification_tokens trustee_contact_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_contact_verification_tokens
    ADD CONSTRAINT trustee_contact_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: trustee_contact_verification_tokens trustee_contact_verification_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_contact_verification_tokens
    ADD CONSTRAINT trustee_contact_verification_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: trustee_invitations trustee_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_invitations
    ADD CONSTRAINT trustee_invitations_pkey PRIMARY KEY (id);


--
-- Name: trustee_invitations trustee_invitations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_invitations
    ADD CONSTRAINT trustee_invitations_token_hash_key UNIQUE (token_hash);


--
-- Name: vault_trustees vault_trustees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_trustees
    ADD CONSTRAINT vault_trustees_pkey PRIMARY KEY (id);


--
-- Name: webauthn_challenges webauthn_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_pkey PRIMARY KEY (id);


--
-- Name: webauthn_credentials webauthn_credentials_credential_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_credential_id_key UNIQUE (credential_id);


--
-- Name: webauthn_credentials webauthn_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_log_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_action ON public.audit_log USING btree (action);


--
-- Name: idx_audit_log_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_actor ON public.audit_log USING btree (actor_id);


--
-- Name: idx_audit_log_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_entity ON public.audit_log USING btree (entity_type, entity_id);


--
-- Name: idx_continuity_brrr_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_brrr_outbox_due ON public.continuity_brrr_outbox USING btree (next_attempt_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'claimed'::text]));


--
-- Name: idx_continuity_delivery_grants_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_delivery_grants_status ON public.continuity_delivery_grants USING btree (status, expires_at);


--
-- Name: idx_continuity_delivery_runs_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_delivery_runs_due ON public.continuity_delivery_runs USING btree (status, trustee_action_deadline_at, pause_deadline_at);


--
-- Name: idx_continuity_delivery_tokens_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_delivery_tokens_expiry ON public.continuity_delivery_tokens USING btree (expires_at) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_continuity_delivery_tokens_one_usable; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_delivery_tokens_one_usable ON public.continuity_delivery_tokens USING btree (delivery_grant_id, purpose) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_continuity_events_switch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_events_switch ON public.continuity_events USING btree (switch_id, occurred_at DESC);


--
-- Name: idx_continuity_operator_attestations_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_operator_attestations_expiry ON public.continuity_operator_channel_attestations USING btree (expires_at) WHERE ((replaced_at IS NULL) AND (acknowledged_at IS NULL));


--
-- Name: idx_continuity_operator_attestations_one_current; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_operator_attestations_one_current ON public.continuity_operator_channel_attestations USING btree (switch_id, channel_type) WHERE (replaced_at IS NULL);


--
-- Name: idx_continuity_outbox_delivery_grant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_outbox_delivery_grant ON public.continuity_notification_outbox USING btree (delivery_grant_id, notification_type) WHERE (delivery_grant_id IS NOT NULL);


--
-- Name: idx_continuity_outbox_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_outbox_due ON public.continuity_notification_outbox USING btree (next_attempt_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'claimed'::text]));


--
-- Name: idx_continuity_outbox_non_grant_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_outbox_non_grant_dedupe ON public.continuity_notification_outbox USING btree (switch_id, schedule_cycle, notification_type, recipient_email) WHERE (delivery_grant_id IS NULL);


--
-- Name: idx_continuity_outbox_run_trustee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_outbox_run_trustee ON public.continuity_notification_outbox USING btree (delivery_run_id, delivery_run_trustee_id, notification_type) WHERE (delivery_run_id IS NOT NULL);


--
-- Name: idx_continuity_packet_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_packet_one_active ON public.continuity_packet_versions USING btree (switch_id) WHERE (status = 'active'::text);


--
-- Name: idx_continuity_packet_one_letter; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_packet_one_letter ON public.continuity_packet_documents USING btree (packet_version_id) WHERE (item_kind = 'letter'::text);


--
-- Name: idx_continuity_packet_one_staged; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_packet_one_staged ON public.continuity_packet_versions USING btree (switch_id) WHERE (status = 'staged'::text);


--
-- Name: idx_continuity_packet_recipient_member; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_packet_recipient_member ON public.continuity_packet_recipients USING btree (packet_version_id, member_id) WHERE (member_id IS NOT NULL);


--
-- Name: idx_continuity_packet_recipient_trustee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_packet_recipient_trustee ON public.continuity_packet_recipients USING btree (packet_version_id, trustee_id) WHERE (trustee_id IS NOT NULL);


--
-- Name: idx_continuity_recipients_member; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_recipients_member ON public.continuity_recipients USING btree (switch_id, member_id) WHERE (member_id IS NOT NULL);


--
-- Name: idx_continuity_recipients_trustee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_recipients_trustee ON public.continuity_recipients USING btree (switch_id, trustee_id) WHERE (trustee_id IS NOT NULL);


--
-- Name: idx_continuity_scheduler_runs_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_scheduler_runs_latest ON public.continuity_scheduler_runs USING btree (job_type, started_at DESC);


--
-- Name: idx_continuity_switches_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_switches_due ON public.continuity_switches USING btree (next_checkin_due_at) WHERE (status = 'armed'::text);


--
-- Name: idx_continuity_switches_one_active_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_switches_one_active_owner ON public.continuity_switches USING btree (owner_id) WHERE (status <> 'cancelled'::text);


--
-- Name: idx_continuity_tokens_one_usable; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_tokens_one_usable ON public.continuity_checkin_tokens USING btree (switch_id) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_continuity_trustee_tokens_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_continuity_trustee_tokens_expiry ON public.continuity_trustee_action_tokens USING btree (expires_at) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_continuity_trustee_tokens_one_usable; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_continuity_trustee_tokens_one_usable ON public.continuity_trustee_action_tokens USING btree (delivery_run_trustee_id, purpose) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_document_designations_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_designations_member ON public.document_designations USING btree (member_id) WHERE (member_id IS NOT NULL);


--
-- Name: idx_document_designations_trustee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_designations_trustee ON public.document_designations USING btree (trustee_id) WHERE (trustee_id IS NOT NULL);


--
-- Name: idx_document_files_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_files_doc ON public.document_files USING btree (document_id);


--
-- Name: idx_document_files_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_files_sha256 ON public.document_files USING btree (sha256) WHERE (sha256 IS NOT NULL);


--
-- Name: idx_document_owners_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_owners_member ON public.document_owners USING btree (member_id);


--
-- Name: idx_documents_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_created_by ON public.documents USING btree (created_by);


--
-- Name: idx_documents_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_expiry ON public.documents USING btree (expiry_date) WHERE (expiry_date IS NOT NULL);


--
-- Name: idx_documents_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_search ON public.documents USING gin (search_vector);


--
-- Name: idx_documents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_status ON public.documents USING btree (status);


--
-- Name: idx_documents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_type ON public.documents USING btree (document_type);


--
-- Name: idx_encryption_keys_member_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_encryption_keys_member_fingerprint ON public.encryption_keys USING btree (member_id, key_fingerprint) WHERE ((key_type = 'member'::text) AND (revoked_at IS NULL));


--
-- Name: idx_encryption_keys_trustee_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_encryption_keys_trustee_fingerprint ON public.encryption_keys USING btree (trustee_id, key_fingerprint) WHERE ((key_type = 'trustee'::text) AND (revoked_at IS NULL));


--
-- Name: idx_import_items_batch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_items_batch_status ON public.import_items USING btree (batch_id, status);


--
-- Name: idx_import_items_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_items_sha256 ON public.import_items USING btree (sha256) WHERE (sha256 IS NOT NULL);


--
-- Name: idx_magic_data_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_data_category ON public.magic_data USING btree (category);


--
-- Name: idx_magic_data_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_data_due ON public.magic_data USING btree (due_date) WHERE (due_date IS NOT NULL);


--
-- Name: idx_magic_data_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_data_scan ON public.magic_data USING btree (scan_id);


--
-- Name: idx_magic_data_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_data_status ON public.magic_data USING btree (status) WHERE (status = ANY (ARRAY['new'::text, 'accepted'::text]));


--
-- Name: idx_magic_data_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_data_subject ON public.magic_data USING btree (subject_type, subject_id);


--
-- Name: idx_magic_links_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_links_source ON public.magic_links USING btree (source_document_id);


--
-- Name: idx_magic_links_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_links_status ON public.magic_links USING btree (status);


--
-- Name: idx_magic_links_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_links_target ON public.magic_links USING btree (target_document_id);


--
-- Name: idx_magic_links_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_magic_links_type ON public.magic_links USING btree (link_type);


--
-- Name: idx_member_contact_channels_member_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_member_contact_channels_member_history ON public.member_contact_channels USING btree (member_id, created_at DESC);


--
-- Name: idx_member_contact_channels_one_current; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_member_contact_channels_one_current ON public.member_contact_channels USING btree (member_id, channel_type) WHERE (status <> 'revoked'::text);


--
-- Name: idx_member_contact_channels_unique_current_address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_member_contact_channels_unique_current_address ON public.member_contact_channels USING btree (channel_type, normalized_address) WHERE (status <> 'revoked'::text);


--
-- Name: idx_member_contact_tokens_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_member_contact_tokens_expiry ON public.member_contact_verification_tokens USING btree (expires_at) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_member_contact_tokens_one_usable; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_member_contact_tokens_one_usable ON public.member_contact_verification_tokens USING btree (contact_channel_id, purpose) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_processing_jobs_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_processing_jobs_document ON public.processing_jobs USING btree (document_id);


--
-- Name: idx_processing_jobs_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_processing_jobs_item ON public.processing_jobs USING btree (import_item_id);


--
-- Name: idx_processing_jobs_pickup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_processing_jobs_pickup ON public.processing_jobs USING btree (status, run_after, id);


--
-- Name: idx_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_expires ON public.sessions USING btree (expires_at);


--
-- Name: idx_sessions_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_token ON public.sessions USING btree (token);


--
-- Name: idx_share_links_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_links_doc ON public.share_links USING btree (document_id);


--
-- Name: idx_share_links_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_share_links_token ON public.share_links USING btree (token);


--
-- Name: idx_trustee_contact_channels_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trustee_contact_channels_history ON public.trustee_contact_channels USING btree (trustee_id, created_at DESC);


--
-- Name: idx_trustee_contact_channels_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_trustee_contact_channels_one_pending ON public.trustee_contact_channels USING btree (trustee_id, channel_type) WHERE (status = 'pending'::text);


--
-- Name: idx_trustee_contact_channels_one_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_trustee_contact_channels_one_verified ON public.trustee_contact_channels USING btree (trustee_id, channel_type) WHERE (status = 'verified'::text);


--
-- Name: idx_trustee_contact_channels_unique_active_address; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_trustee_contact_channels_unique_active_address ON public.trustee_contact_channels USING btree (channel_type, normalized_address) WHERE (status <> 'revoked'::text);


--
-- Name: idx_trustee_contact_tokens_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trustee_contact_tokens_expiry ON public.trustee_contact_verification_tokens USING btree (expires_at) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_trustee_contact_tokens_one_usable; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_trustee_contact_tokens_one_usable ON public.trustee_contact_verification_tokens USING btree (contact_channel_id, purpose) WHERE ((consumed_at IS NULL) AND (replaced_at IS NULL));


--
-- Name: idx_trustee_invitations_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trustee_invitations_active ON public.trustee_invitations USING btree (trustee_id, expires_at) WHERE (used_at IS NULL);


--
-- Name: idx_vault_trustees_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_vault_trustees_email ON public.vault_trustees USING btree (lower(email));


--
-- Name: idx_webauthn_challenges_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_challenges_expires ON public.webauthn_challenges USING btree (expires_at);


--
-- Name: idx_webauthn_challenges_member_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_challenges_member_purpose ON public.webauthn_challenges USING btree (member_id, purpose, created_at DESC);


--
-- Name: idx_webauthn_challenges_trustee_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_challenges_trustee_purpose ON public.webauthn_challenges USING btree (trustee_id, purpose, created_at DESC) WHERE (trustee_id IS NOT NULL);


--
-- Name: idx_webauthn_credentials_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_credentials_member ON public.webauthn_credentials USING btree (member_id, created_at DESC);


--
-- Name: idx_webauthn_credentials_trustee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webauthn_credentials_trustee ON public.webauthn_credentials USING btree (trustee_id, created_at DESC) WHERE (trustee_id IS NOT NULL);


--
-- Name: continuity_delivery_grants trg_continuity_delivery_grant_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_delivery_grant_identity BEFORE INSERT OR DELETE OR UPDATE ON public.continuity_delivery_grants FOR EACH ROW EXECUTE FUNCTION public.enforce_continuity_delivery_grant_identity();


--
-- Name: continuity_delivery_items trg_continuity_delivery_items_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_delivery_items_immutable BEFORE DELETE OR UPDATE ON public.continuity_delivery_items FOR EACH ROW EXECUTE FUNCTION public.reject_continuity_delivery_item_update();


--
-- Name: continuity_delivery_runs trg_continuity_delivery_run_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_delivery_run_identity BEFORE UPDATE ON public.continuity_delivery_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_continuity_delivery_run_identity();


--
-- Name: continuity_packet_recipient_documents trg_continuity_packet_coverage_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_packet_coverage_immutable BEFORE DELETE OR UPDATE ON public.continuity_packet_recipient_documents FOR EACH ROW EXECUTE FUNCTION public.reject_continuity_packet_child_update();


--
-- Name: continuity_packet_documents trg_continuity_packet_documents_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_packet_documents_immutable BEFORE DELETE OR UPDATE ON public.continuity_packet_documents FOR EACH ROW EXECUTE FUNCTION public.reject_continuity_packet_child_update();


--
-- Name: continuity_packet_recipients trg_continuity_packet_recipients_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_packet_recipients_immutable BEFORE DELETE OR UPDATE ON public.continuity_packet_recipients FOR EACH ROW EXECUTE FUNCTION public.reject_continuity_packet_child_update();


--
-- Name: continuity_packet_versions trg_continuity_packet_version_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_packet_version_transition BEFORE DELETE OR UPDATE ON public.continuity_packet_versions FOR EACH ROW EXECUTE FUNCTION public.enforce_continuity_packet_version_transition();


--
-- Name: continuity_delivery_run_trustees trg_continuity_run_trustee_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_continuity_run_trustee_snapshot BEFORE UPDATE ON public.continuity_delivery_run_trustees FOR EACH ROW EXECUTE FUNCTION public.enforce_continuity_run_trustee_snapshot();


--
-- Name: documents trg_documents_search; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_documents_search BEFORE INSERT OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.documents_search_trigger();


--
-- Name: import_batches trg_import_batches_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_import_batches_updated_at BEFORE UPDATE ON public.import_batches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: import_items trg_import_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_import_items_updated_at BEFORE UPDATE ON public.import_items FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: magic_data trg_magic_data_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_magic_data_updated_at BEFORE UPDATE ON public.magic_data FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: magic_links trg_magic_links_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_magic_links_updated_at BEFORE UPDATE ON public.magic_links FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: processing_jobs trg_processing_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_processing_jobs_updated_at BEFORE UPDATE ON public.processing_jobs FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: audit_log audit_log_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.family_members(id);


--
-- Name: continuity_brrr_outbox continuity_brrr_outbox_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_brrr_outbox
    ADD CONSTRAINT continuity_brrr_outbox_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.continuity_events(id) ON DELETE SET NULL;


--
-- Name: continuity_brrr_outbox continuity_brrr_outbox_notification_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_brrr_outbox
    ADD CONSTRAINT continuity_brrr_outbox_notification_channel_id_fkey FOREIGN KEY (notification_channel_id) REFERENCES public.member_notification_channels(id) ON DELETE SET NULL;


--
-- Name: continuity_brrr_outbox continuity_brrr_outbox_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_brrr_outbox
    ADD CONSTRAINT continuity_brrr_outbox_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_checkin_tokens continuity_checkin_tokens_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_checkin_tokens
    ADD CONSTRAINT continuity_checkin_tokens_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_delivery_grants continuity_delivery_grants_delivery_run_id_packet_version__fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_delivery_run_id_packet_version__fkey FOREIGN KEY (delivery_run_id, packet_version_id) REFERENCES public.continuity_delivery_runs(id, packet_version_id) ON DELETE CASCADE;


--
-- Name: continuity_delivery_grants continuity_delivery_grants_member_contact_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_member_contact_channel_id_fkey FOREIGN KEY (member_contact_channel_id) REFERENCES public.member_contact_channels(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_grants continuity_delivery_grants_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_grants continuity_delivery_grants_packet_recipient_id_packet_vers_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_packet_recipient_id_packet_vers_fkey FOREIGN KEY (packet_recipient_id, packet_version_id) REFERENCES public.continuity_packet_recipients(id, packet_version_id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_grants continuity_delivery_grants_trustee_contact_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_trustee_contact_channel_id_fkey FOREIGN KEY (trustee_contact_channel_id) REFERENCES public.trustee_contact_channels(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_grants continuity_delivery_grants_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_grants
    ADD CONSTRAINT continuity_delivery_grants_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_items continuity_delivery_items_delivery_grant_id_packet_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_delivery_grant_id_packet_version_fkey FOREIGN KEY (delivery_grant_id, packet_version_id) REFERENCES public.continuity_delivery_grants(id, packet_version_id) ON DELETE CASCADE;


--
-- Name: continuity_delivery_items continuity_delivery_items_designation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_designation_id_fkey FOREIGN KEY (designation_id) REFERENCES public.document_designations(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_items continuity_delivery_items_document_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_document_file_id_fkey FOREIGN KEY (document_file_id) REFERENCES public.document_files(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_items continuity_delivery_items_encryption_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_encryption_key_id_fkey FOREIGN KEY (encryption_key_id) REFERENCES public.encryption_keys(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_items continuity_delivery_items_packet_document_id_packet_versio_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_items
    ADD CONSTRAINT continuity_delivery_items_packet_document_id_packet_versio_fkey FOREIGN KEY (packet_document_id, packet_version_id) REFERENCES public.continuity_packet_documents(id, packet_version_id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_run_trustees continuity_delivery_run_trustees_contact_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_run_trustees
    ADD CONSTRAINT continuity_delivery_run_trustees_contact_channel_id_fkey FOREIGN KEY (contact_channel_id) REFERENCES public.trustee_contact_channels(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_run_trustees continuity_delivery_run_trustees_delivery_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_run_trustees
    ADD CONSTRAINT continuity_delivery_run_trustees_delivery_run_id_fkey FOREIGN KEY (delivery_run_id) REFERENCES public.continuity_delivery_runs(id) ON DELETE CASCADE;


--
-- Name: continuity_delivery_run_trustees continuity_delivery_run_trustees_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_run_trustees
    ADD CONSTRAINT continuity_delivery_run_trustees_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_runs continuity_delivery_runs_packet_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_runs
    ADD CONSTRAINT continuity_delivery_runs_packet_version_id_fkey FOREIGN KEY (packet_version_id) REFERENCES public.continuity_packet_versions(id) ON DELETE RESTRICT;


--
-- Name: continuity_delivery_runs continuity_delivery_runs_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_runs
    ADD CONSTRAINT continuity_delivery_runs_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_delivery_tokens continuity_delivery_tokens_delivery_grant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_delivery_tokens
    ADD CONSTRAINT continuity_delivery_tokens_delivery_grant_id_fkey FOREIGN KEY (delivery_grant_id) REFERENCES public.continuity_delivery_grants(id) ON DELETE CASCADE;


--
-- Name: continuity_events continuity_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_events
    ADD CONSTRAINT continuity_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.family_members(id);


--
-- Name: continuity_events continuity_events_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_events
    ADD CONSTRAINT continuity_events_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_notification_outbox continuity_notification_outbo_delivery_grant_id_delivery_r_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbo_delivery_grant_id_delivery_r_fkey FOREIGN KEY (delivery_grant_id, delivery_run_id) REFERENCES public.continuity_delivery_grants(id, delivery_run_id) ON DELETE CASCADE;


--
-- Name: continuity_notification_outbox continuity_notification_outbo_delivery_run_trustee_id_deli_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbo_delivery_run_trustee_id_deli_fkey FOREIGN KEY (delivery_run_trustee_id, delivery_run_id) REFERENCES public.continuity_delivery_run_trustees(id, delivery_run_id) ON DELETE CASCADE;


--
-- Name: continuity_notification_outbox continuity_notification_outbo_delivery_token_id_delivery_g_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbo_delivery_token_id_delivery_g_fkey FOREIGN KEY (delivery_token_id, delivery_grant_id) REFERENCES public.continuity_delivery_tokens(id, delivery_grant_id) ON DELETE SET NULL (delivery_token_id);


--
-- Name: continuity_notification_outbox continuity_notification_outbo_trustee_action_token_id_deli_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbo_trustee_action_token_id_deli_fkey FOREIGN KEY (trustee_action_token_id, delivery_run_id, delivery_run_trustee_id) REFERENCES public.continuity_trustee_action_tokens(id, delivery_run_id, delivery_run_trustee_id) ON DELETE SET NULL (trustee_action_token_id);


--
-- Name: continuity_notification_outbox continuity_notification_outbox_delivery_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbox_delivery_run_id_fkey FOREIGN KEY (delivery_run_id) REFERENCES public.continuity_delivery_runs(id) ON DELETE CASCADE;


--
-- Name: continuity_notification_outbox continuity_notification_outbox_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbox_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.continuity_events(id) ON DELETE SET NULL;


--
-- Name: continuity_notification_outbox continuity_notification_outbox_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_notification_outbox
    ADD CONSTRAINT continuity_notification_outbox_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_operator_channel_attestations continuity_operator_channel_attestations_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_operator_channel_attestations
    ADD CONSTRAINT continuity_operator_channel_attestations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: continuity_operator_channel_attestations continuity_operator_channel_attestations_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_operator_channel_attestations
    ADD CONSTRAINT continuity_operator_channel_attestations_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_packet_documents continuity_packet_documents_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_documents
    ADD CONSTRAINT continuity_packet_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE RESTRICT;


--
-- Name: continuity_packet_documents continuity_packet_documents_packet_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_documents
    ADD CONSTRAINT continuity_packet_documents_packet_version_id_fkey FOREIGN KEY (packet_version_id) REFERENCES public.continuity_packet_versions(id) ON DELETE CASCADE;


--
-- Name: continuity_packet_recipient_documents continuity_packet_recipient_d_packet_document_id_packet_ve_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents
    ADD CONSTRAINT continuity_packet_recipient_d_packet_document_id_packet_ve_fkey FOREIGN KEY (packet_document_id, packet_version_id) REFERENCES public.continuity_packet_documents(id, packet_version_id) ON DELETE CASCADE;


--
-- Name: continuity_packet_recipient_documents continuity_packet_recipient_d_packet_recipient_id_packet_v_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents
    ADD CONSTRAINT continuity_packet_recipient_d_packet_recipient_id_packet_v_fkey FOREIGN KEY (packet_recipient_id, packet_version_id) REFERENCES public.continuity_packet_recipients(id, packet_version_id) ON DELETE CASCADE;


--
-- Name: continuity_packet_recipient_documents continuity_packet_recipient_documents_designation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents
    ADD CONSTRAINT continuity_packet_recipient_documents_designation_id_fkey FOREIGN KEY (designation_id) REFERENCES public.document_designations(id) ON DELETE RESTRICT;


--
-- Name: continuity_packet_recipient_documents continuity_packet_recipient_documents_encryption_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents
    ADD CONSTRAINT continuity_packet_recipient_documents_encryption_key_id_fkey FOREIGN KEY (encryption_key_id) REFERENCES public.encryption_keys(id) ON DELETE RESTRICT;


--
-- Name: continuity_packet_recipient_documents continuity_packet_recipient_documents_packet_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipient_documents
    ADD CONSTRAINT continuity_packet_recipient_documents_packet_version_id_fkey FOREIGN KEY (packet_version_id) REFERENCES public.continuity_packet_versions(id) ON DELETE CASCADE;


--
-- Name: continuity_packet_recipients continuity_packet_recipients_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipients
    ADD CONSTRAINT continuity_packet_recipients_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id);


--
-- Name: continuity_packet_recipients continuity_packet_recipients_packet_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipients
    ADD CONSTRAINT continuity_packet_recipients_packet_version_id_fkey FOREIGN KEY (packet_version_id) REFERENCES public.continuity_packet_versions(id) ON DELETE CASCADE;


--
-- Name: continuity_packet_recipients continuity_packet_recipients_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_recipients
    ADD CONSTRAINT continuity_packet_recipients_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id);


--
-- Name: continuity_packet_versions continuity_packet_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_versions
    ADD CONSTRAINT continuity_packet_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.family_members(id);


--
-- Name: continuity_packet_versions continuity_packet_versions_letter_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_versions
    ADD CONSTRAINT continuity_packet_versions_letter_document_id_fkey FOREIGN KEY (letter_document_id) REFERENCES public.documents(id) ON DELETE RESTRICT;


--
-- Name: continuity_packet_versions continuity_packet_versions_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_packet_versions
    ADD CONSTRAINT continuity_packet_versions_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_recipients continuity_recipients_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_recipients
    ADD CONSTRAINT continuity_recipients_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id);


--
-- Name: continuity_recipients continuity_recipients_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_recipients
    ADD CONSTRAINT continuity_recipients_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_recipients continuity_recipients_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_recipients
    ADD CONSTRAINT continuity_recipients_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id);


--
-- Name: continuity_switch_trustees continuity_switch_trustees_switch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switch_trustees
    ADD CONSTRAINT continuity_switch_trustees_switch_id_fkey FOREIGN KEY (switch_id) REFERENCES public.continuity_switches(id) ON DELETE CASCADE;


--
-- Name: continuity_switch_trustees continuity_switch_trustees_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switch_trustees
    ADD CONSTRAINT continuity_switch_trustees_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id) ON DELETE RESTRICT;


--
-- Name: continuity_switches continuity_switches_active_packet_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switches
    ADD CONSTRAINT continuity_switches_active_packet_version_id_fkey FOREIGN KEY (active_packet_version_id) REFERENCES public.continuity_packet_versions(id) ON DELETE SET NULL;


--
-- Name: continuity_switches continuity_switches_letter_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switches
    ADD CONSTRAINT continuity_switches_letter_document_id_fkey FOREIGN KEY (letter_document_id) REFERENCES public.documents(id);


--
-- Name: continuity_switches continuity_switches_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switches
    ADD CONSTRAINT continuity_switches_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: continuity_switches continuity_switches_staged_letter_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switches
    ADD CONSTRAINT continuity_switches_staged_letter_document_id_fkey FOREIGN KEY (staged_letter_document_id) REFERENCES public.documents(id);


--
-- Name: continuity_switches continuity_switches_staged_packet_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_switches
    ADD CONSTRAINT continuity_switches_staged_packet_version_id_fkey FOREIGN KEY (staged_packet_version_id) REFERENCES public.continuity_packet_versions(id) ON DELETE SET NULL;


--
-- Name: continuity_trustee_action_tokens continuity_trustee_action_tok_delivery_run_trustee_id_deli_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_trustee_action_tokens
    ADD CONSTRAINT continuity_trustee_action_tok_delivery_run_trustee_id_deli_fkey FOREIGN KEY (delivery_run_trustee_id, delivery_run_id) REFERENCES public.continuity_delivery_run_trustees(id, delivery_run_id) ON DELETE CASCADE;


--
-- Name: continuity_trustee_action_tokens continuity_trustee_action_tokens_delivery_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continuity_trustee_action_tokens
    ADD CONSTRAINT continuity_trustee_action_tokens_delivery_run_id_fkey FOREIGN KEY (delivery_run_id) REFERENCES public.continuity_delivery_runs(id) ON DELETE CASCADE;


--
-- Name: document_designations document_designations_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_designations
    ADD CONSTRAINT document_designations_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_designations document_designations_encryption_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_designations
    ADD CONSTRAINT document_designations_encryption_key_id_fkey FOREIGN KEY (encryption_key_id) REFERENCES public.encryption_keys(id);


--
-- Name: document_designations document_designations_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_designations
    ADD CONSTRAINT document_designations_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id);


--
-- Name: document_designations document_designations_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_designations
    ADD CONSTRAINT document_designations_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id);


--
-- Name: document_files document_files_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_files
    ADD CONSTRAINT document_files_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_owners document_owners_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_owners
    ADD CONSTRAINT document_owners_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_owners document_owners_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_owners
    ADD CONSTRAINT document_owners_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: document_tags document_tags_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_tags document_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_tags
    ADD CONSTRAINT document_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: documents documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.family_members(id);


--
-- Name: documents documents_encryption_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_encryption_key_id_fkey FOREIGN KEY (encryption_key_id) REFERENCES public.encryption_keys(id);


--
-- Name: encryption_keys encryption_keys_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_keys
    ADD CONSTRAINT encryption_keys_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id);


--
-- Name: encryption_keys encryption_keys_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_keys
    ADD CONSTRAINT encryption_keys_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id);


--
-- Name: import_batches import_batches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.family_members(id);


--
-- Name: import_items import_items_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_items
    ADD CONSTRAINT import_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id) ON DELETE CASCADE;


--
-- Name: import_items import_items_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_items
    ADD CONSTRAINT import_items_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;


--
-- Name: magic_data magic_data_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_data
    ADD CONSTRAINT magic_data_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.family_members(id);


--
-- Name: magic_links magic_links_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.family_members(id);


--
-- Name: magic_links magic_links_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: magic_links magic_links_target_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_links
    ADD CONSTRAINT magic_links_target_document_id_fkey FOREIGN KEY (target_document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: member_contact_channels member_contact_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_channels
    ADD CONSTRAINT member_contact_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.family_members(id);


--
-- Name: member_contact_channels member_contact_channels_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_channels
    ADD CONSTRAINT member_contact_channels_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: member_contact_verification_tokens member_contact_verification_tokens_contact_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_contact_verification_tokens
    ADD CONSTRAINT member_contact_verification_tokens_contact_channel_id_fkey FOREIGN KEY (contact_channel_id) REFERENCES public.member_contact_channels(id) ON DELETE CASCADE;


--
-- Name: member_notification_channels member_notification_channels_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notification_channels
    ADD CONSTRAINT member_notification_channels_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: processing_jobs processing_jobs_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_jobs
    ADD CONSTRAINT processing_jobs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: processing_jobs processing_jobs_import_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processing_jobs
    ADD CONSTRAINT processing_jobs_import_item_id_fkey FOREIGN KEY (import_item_id) REFERENCES public.import_items(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: share_links share_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.family_members(id);


--
-- Name: share_links share_links_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.share_links
    ADD CONSTRAINT share_links_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: trustee_contact_channels trustee_contact_channels_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_contact_channels
    ADD CONSTRAINT trustee_contact_channels_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id) ON DELETE CASCADE;


--
-- Name: trustee_contact_verification_tokens trustee_contact_verification_tokens_contact_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_contact_verification_tokens
    ADD CONSTRAINT trustee_contact_verification_tokens_contact_channel_id_fkey FOREIGN KEY (contact_channel_id) REFERENCES public.trustee_contact_channels(id) ON DELETE CASCADE;


--
-- Name: trustee_invitations trustee_invitations_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trustee_invitations
    ADD CONSTRAINT trustee_invitations_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id) ON DELETE CASCADE;


--
-- Name: vault_trustees vault_trustees_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_trustees
    ADD CONSTRAINT vault_trustees_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.family_members(id);


--
-- Name: webauthn_challenges webauthn_challenges_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: webauthn_challenges webauthn_challenges_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id) ON DELETE CASCADE;


--
-- Name: webauthn_credentials webauthn_credentials_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE CASCADE;


--
-- Name: webauthn_credentials webauthn_credentials_trustee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webauthn_credentials
    ADD CONSTRAINT webauthn_credentials_trustee_id_fkey FOREIGN KEY (trustee_id) REFERENCES public.vault_trustees(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



-- Default application configuration seeded by migration 001.
INSERT INTO public.app_config (key, value) VALUES
  ('backup_policy', '{"frequency_days": 30, "notify_overdue_days": 7, "encrypt_backups": false}');
