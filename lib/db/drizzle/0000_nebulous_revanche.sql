CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"replaced_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_id" integer,
	"severity" varchar(20) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"channel" varchar(20) DEFAULT 'in_app' NOT NULL,
	"webhook_url" text,
	"delivered" boolean DEFAULT false NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"phone" text,
	"tort_type" varchar(100) NOT NULL,
	"exposure_start" date,
	"exposure_end" date,
	"diagnosis_confirmed" boolean DEFAULT false NOT NULL,
	"diagnosis_type" varchar(255),
	"was_at_location" boolean DEFAULT false NOT NULL,
	"location_name" varchar(255),
	"status" varchar(20) DEFAULT 'new' NOT NULL,
	"rejection_reason" text,
	"notes" text,
	"ad_spend" numeric(10, 2),
	"source" varchar(100),
	"assigned_to" integer,
	"routing" varchar(20) DEFAULT 'cold',
	"first_name" varchar(255),
	"last_name" varchar(255),
	"date_of_birth" text,
	"street_address" text,
	"city" varchar(100),
	"state" varchar(2),
	"zip" varchar(10),
	"phone_primary" text,
	"last_4_ssn" text,
	"diagnosis" text,
	"diagnosis_date" text,
	"physician_first_name" varchar(255),
	"physician_last_name" varchar(255),
	"physician_full_address" text,
	"physician_contact_info" text,
	"hospital_name" varchar(500),
	"hospital_fax" varchar(50),
	"hospital_contact_info" text,
	"tcpa_consent" boolean DEFAULT false,
	"trustedform_cert_url" text,
	"trustedform_ping_url" text,
	"trustedform_cert_token" text,
	"trustedform_ip" varchar(45),
	"trustedform_user_agent" text,
	"trustedform_timestamp" timestamp,
	"medications" text,
	"npi_verified" boolean,
	"npi_number" varchar(10),
	"physician_taxonomy" varchar(255),
	"fraud_score" integer,
	"fraud_status" varchar(20),
	"fraud_indicators" text,
	"email_validation_status" varchar(20),
	"address_validation_status" varchar(20),
	"background_check_status" varchar(20),
	"background_check_data" text,
	"vendor_id" integer,
	"law_firm" varchar(255),
	"client_id" varchar(100),
	"buyer_id" integer,
	"created_by_user_id" integer,
	"firm_id" integer,
	"lookup_hash" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"convexity_score" varchar(20),
	"convexity_action" varchar(20),
	"convexity_rationale" text,
	"convexity_ruin_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"convexity_downside_usd" numeric(12, 2),
	"convexity_upside_usd" numeric(12, 2),
	"convexity_ratio" numeric(10, 4),
	"convexity_confidence" varchar(10),
	"convexity_missing_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"convexity_contradictions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"convexity_computed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"document_type" varchar(50) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_url" text,
	"signed" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"data" jsonb,
	"status" varchar(50) DEFAULT 'open' NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"assigned_to" integer,
	"firm_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" varchar(36) NOT NULL,
	"features" jsonb,
	"score" real,
	"ai_model" varchar(100),
	"raw_text_length" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempts" serial NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(100) NOT NULL,
	"action" varchar(50) NOT NULL,
	"details" jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" varchar(36) NOT NULL,
	"path" text NOT NULL,
	"file_hash" varchar(64),
	"file_name" varchar(255) NOT NULL,
	"content_type" varchar(100),
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fax_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer,
	"lead_id" integer,
	"source_file" text NOT NULL,
	"vault_path" text NOT NULL,
	"rx_number" text DEFAULT '' NOT NULL,
	"drug_name" text DEFAULT '' NOT NULL,
	"fill_date" text DEFAULT '' NOT NULL,
	"quantity" text DEFAULT '' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"raw_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "paralegals" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"role" varchar(100) DEFAULT 'Paralegal' NOT NULL,
	"active_cases" integer DEFAULT 0 NOT NULL,
	"signed_cases" integer DEFAULT 0 NOT NULL,
	"total_assigned" integer DEFAULT 0 NOT NULL,
	"assigned_torts" text[],
	"licensed_states" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(100) NOT NULL,
	"conflict_type" varchar(50) NOT NULL,
	"severity" varchar(20) DEFAULT 'medium' NOT NULL,
	"failsafe_mode" varchar(20) NOT NULL,
	"source_module" varchar(100) NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb,
	"resolution" varchar(20) DEFAULT 'pending',
	"resolution_notes" text,
	"resolved_by" varchar(100),
	"resolved_at" timestamp,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact_name" varchar(255),
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"type" varchar(50) DEFAULT 'lead_gen' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_ips" (
	"id" serial PRIMARY KEY NOT NULL,
	"ip" varchar(45) NOT NULL,
	"reason" text NOT NULL,
	"blocked_until" timestamp,
	"auto_blocked" boolean DEFAULT true,
	"alert_count" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_ips_ip_unique" UNIQUE("ip")
);
--> statement-breakpoint
CREATE TABLE "security_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" varchar(50) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"source_ip" varchar(45),
	"user_agent" text,
	"request_path" text,
	"request_method" varchar(10),
	"details" text NOT NULL,
	"payload_sample" text,
	"ai_analysis" text,
	"status" varchar(20) DEFAULT 'new' NOT NULL,
	"blocked" boolean DEFAULT false,
	"country" varchar(50),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mtos_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(20) DEFAULT 'viewer' NOT NULL,
	"firm_id" integer NOT NULL,
	"password_hash" text NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"totp_secret" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	"email_verified_at" timestamp,
	"email_verification_token_hash" text,
	"email_verification_token_expires_at" timestamp,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mtos_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"api_url" text,
	"api_key_hash" text,
	"webhook_url" text,
	"config" jsonb,
	"last_sync_at" timestamp,
	"sync_direction" text DEFAULT 'bidirectional',
	"field_mapping" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "image_objects" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"file_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"source_type" varchar(50) DEFAULT 'upload' NOT NULL,
	"vault_path" text NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"ocr_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"ocr_text" text,
	"ocr_confidence" integer,
	"ocr_extracted_fields" jsonb,
	"lead_id" integer,
	"document_id" integer,
	"fax_result_id" integer,
	"case_id" varchar(100),
	"is_sensitive" boolean DEFAULT true NOT NULL,
	"access_classification" varchar(20) DEFAULT 'confidential' NOT NULL,
	"retention_days" integer DEFAULT 2555,
	"metadata" jsonb,
	"created_by" varchar(255) DEFAULT 'system' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"column_mapping" jsonb,
	"created_by" varchar(255) DEFAULT 'system' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"row_number" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"raw_data" jsonb NOT NULL,
	"lead_id" integer,
	"dedup_match_id" integer,
	"dedup_reason" text,
	"error_message" text,
	"conflict_details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "form_configurations" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"label" varchar(255) NOT NULL,
	"category" varchar(50) NOT NULL,
	"valid_diagnoses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exposure_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_exposure" boolean DEFAULT false NOT NULL,
	"intro_text" varchar(1000),
	"active" boolean DEFAULT true NOT NULL,
	"avg_settlement_low" integer,
	"avg_settlement_high" integer,
	"expected_duration_months" integer,
	"mdl_status" varchar(30),
	"sol_months" integer,
	"web_form_config" jsonb,
	"updated_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_background_check_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"version" varchar(50) NOT NULL,
	"final_status" varchar(20) NOT NULL,
	"overall_score" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"channel" varchar(50) DEFAULT 'other' NOT NULL,
	"cost_per_lead" numeric(10, 2),
	"historical_qualified_rate" numeric(5, 4),
	"historical_retained_rate" numeric(5, 4),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lead_sources_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "decision_engine_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"concentration_warning_pct" integer DEFAULT 40 NOT NULL,
	"ruin_auto_flag" boolean DEFAULT false NOT NULL,
	"default_attorney_hourly_cost" numeric(8, 2) DEFAULT '250.00' NOT NULL,
	"default_hours_per_lead" numeric(6, 2) DEFAULT '8.00' NOT NULL,
	"convex_ratio_threshold" numeric(6, 2) DEFAULT '5.00' NOT NULL,
	"concave_ratio_threshold" numeric(6, 2) DEFAULT '1.50' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"legal_name" varchar(255),
	"contact_name" varchar(255),
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"notes" text,
	"esign_provider_integration_id" integer,
	"fax_provider_integration_id" integer,
	"email_provider_integration_id" integer,
	"default_email_from_name" varchar(255),
	"default_email_from_address" varchar(255),
	"default_fax_from_number" varchar(50),
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "buyers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"template_type" varchar(50) NOT NULL,
	"description" text,
	"source" varchar(20) DEFAULT 'pdf' NOT NULL,
	"storage_path" text,
	"ai_prompt" text,
	"requires_signature" boolean DEFAULT true NOT NULL,
	"signer_role" varchar(50) DEFAULT 'lead' NOT NULL,
	"merge_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delivery_subject" varchar(255),
	"delivery_message" text,
	"triggers_med_records_request" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"uploaded_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"buyer_id" integer,
	"tort_type" varchar(100),
	"enabled" boolean DEFAULT true NOT NULL,
	"send_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_envelopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"template_id" integer,
	"document_id" integer,
	"provider" varchar(50) NOT NULL,
	"provider_integration_id" integer,
	"external_envelope_id" varchar(255),
	"signer_name" varchar(255),
	"signer_email" varchar(255),
	"status" varchar(30) DEFAULT 'created' NOT NULL,
	"status_detail" text,
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"viewed_at" timestamp,
	"signed_at" timestamp,
	"declined_at" timestamp,
	"signed_pdf_path" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"scope" varchar(100) NOT NULL,
	"esign_provider_integration_id" integer,
	"fax_provider_integration_id" integer,
	"email_provider_integration_id" integer,
	"sms_provider_integration_id" integer,
	"voice_provider_integration_id" integer,
	"llm_default_provider_integration_id" integer,
	"llm_drafting_provider_integration_id" integer,
	"default_email_from_name" varchar(255),
	"default_email_from_address" varchar(255),
	"default_fax_from_number" varchar(50),
	"auto_send_on_approval" boolean DEFAULT true NOT NULL,
	"auto_fax_doctor_on_signed_hipaa" boolean DEFAULT true NOT NULL,
	"esign_resend_after_days" integer DEFAULT 3 NOT NULL,
	"esign_expire_after_days" integer DEFAULT 14 NOT NULL,
	"max_send_retries" integer DEFAULT 3 NOT NULL,
	"notify_on_failure_email" varchar(255),
	"med_records_cover_letter_template_id" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"content_type" varchar(100) DEFAULT 'application/pdf' NOT NULL,
	"content" "bytea" NOT NULL,
	"hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "template_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"billing_email" varchar(255),
	"stripe_customer_id" varchar(100),
	"stripe_subscription_id" varchar(100),
	"subscription_status" varchar(30) DEFAULT 'inactive' NOT NULL,
	"current_period_end" timestamp,
	"plan_price_id" varchar(100),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"email_prefill" varchar(255),
	"expires_at" timestamp NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"claimed_by_user_id" integer,
	"claimed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"lead_id" integer,
	"vapi_call_id" varchar(100),
	"direction" varchar(10) DEFAULT 'inbound' NOT NULL,
	"from_number" varchar(32),
	"to_number" varchar(32),
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp,
	"duration_seconds" integer,
	"recording_url" text,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intake_result" jsonb,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_dispositions" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"lead_id" integer NOT NULL,
	"disposition" varchar(30) NOT NULL,
	"reason" text,
	"source" varchar(30) DEFAULT 'system' NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"lead_id" integer,
	"direction" varchar(10) DEFAULT 'outbound' NOT NULL,
	"from_phone_e164" varchar(20),
	"to_phone_e164" varchar(20) NOT NULL,
	"body" text NOT NULL,
	"telnyx_message_id" varchar(100),
	"external_message_id" varchar(128),
	"provider" varchar(32),
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"error" text,
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"failed_at" timestamp,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_dark_room_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"firm_id" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"trigger_source" varchar(40) DEFAULT 'manual' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"step_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_by_user_id" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "automation_workflows" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"name" varchar(200) NOT NULL,
	"description" text,
	"graph" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_type" varchar(40) DEFAULT 'manual' NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"integration_id" integer,
	"firm_id" integer,
	"lead_id" integer,
	"provider" varchar(64) NOT NULL,
	"external_message_id" varchar(255),
	"event_type" varchar(64) NOT NULL,
	"recipient_email" varchar(320),
	"signature_status" varchar(32) DEFAULT 'unknown' NOT NULL,
	"raw_payload" jsonb,
	"error" text,
	"occurred_at" timestamp,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fax_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"integration_id" integer,
	"firm_id" integer,
	"lead_id" integer,
	"provider" varchar(64) NOT NULL,
	"external_fax_id" varchar(255),
	"event_type" varchar(64) NOT NULL,
	"status" varchar(64),
	"pages" integer,
	"signature_status" varchar(32) DEFAULT 'unknown' NOT NULL,
	"raw_payload" jsonb,
	"error" text,
	"occurred_at" timestamp,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fasten_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"lead_id" integer NOT NULL,
	"backend" varchar(16) DEFAULT 'connect' NOT NULL,
	"org_connection_id" varchar(128),
	"portal_id" varchar(128),
	"portal_name" varchar(255),
	"fhir_endpoint" text,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"sync_token" text,
	"last_synced_at" timestamp,
	"last_resource_count" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"api_key_id" integer NOT NULL,
	"route" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"firm_id" integer NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "self_heal_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"jules_session_id" text,
	"jules_session_name" text,
	"source_name" text NOT NULL,
	"starting_branch" text DEFAULT 'main' NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"automation_mode" text DEFAULT 'AUTO_CREATE_PR' NOT NULL,
	"require_plan_approval" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pr_url" text,
	"pr_title" text,
	"last_error" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "self_heal_sessions_jules_session_id_unique" UNIQUE("jules_session_id")
);
--> statement-breakpoint
CREATE TABLE "competitive_intel_advertisers" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"advertiser_id" text NOT NULL,
	"label" text NOT NULL,
	"notes" text,
	"added_by_user_id" integer NOT NULL,
	"last_fetched_at" timestamp,
	"last_ad_count" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitive_intel_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"advertiser_id_fk" integer NOT NULL,
	"raw_response" jsonb NOT NULL,
	"ad_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"integration_id" integer,
	"firm_id" integer,
	"event_type" text,
	"first_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis" ADD CONSTRAINT "analysis_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_documents" ADD CONSTRAINT "case_documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mtos_users" ADD CONSTRAINT "mtos_users_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_envelopes" ADD CONSTRAINT "document_envelopes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_envelopes" ADD CONSTRAINT "document_envelopes_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_envelopes" ADD CONSTRAINT "document_envelopes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_invites" ADD CONSTRAINT "firm_invites_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_invites" ADD CONSTRAINT "firm_invites_created_by_user_id_mtos_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mtos_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_invites" ADD CONSTRAINT "firm_invites_claimed_by_user_id_mtos_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."mtos_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_dark_room_links" ADD CONSTRAINT "admin_dark_room_links_user_id_mtos_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mtos_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fasten_connections" ADD CONSTRAINT "fasten_connections_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fasten_connections" ADD CONSTRAINT "fasten_connections_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_audit" ADD CONSTRAINT "api_key_audit_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_mtos_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mtos_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_heal_sessions" ADD CONSTRAINT "self_heal_sessions_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_heal_sessions" ADD CONSTRAINT "self_heal_sessions_created_by_user_id_mtos_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mtos_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitive_intel_advertisers" ADD CONSTRAINT "competitive_intel_advertisers_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitive_intel_advertisers" ADD CONSTRAINT "competitive_intel_advertisers_added_by_user_id_mtos_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."mtos_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitive_intel_snapshots" ADD CONSTRAINT "competitive_intel_snapshots_advertiser_id_fk_competitive_intel_advertisers_id_fk" FOREIGN KEY ("advertiser_id_fk") REFERENCES "public"."competitive_intel_advertisers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_tort_type_idx" ON "leads" USING btree ("tort_type");--> statement-breakpoint
CREATE INDEX "leads_created_at_idx" ON "leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "leads_updated_at_idx" ON "leads" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "leads_vendor_id_idx" ON "leads" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "leads_buyer_id_idx" ON "leads" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "leads_assigned_to_idx" ON "leads" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "leads_created_by_user_id_idx" ON "leads" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "leads_status_created_at_idx" ON "leads" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "leads_tort_status_idx" ON "leads" USING btree ("tort_type","status");--> statement-breakpoint
CREATE INDEX "leads_firm_id_idx" ON "leads" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "leads_lookup_hash_idx" ON "leads" USING btree ("lookup_hash");--> statement-breakpoint
CREATE INDEX "documents_lead_id_idx" ON "documents" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "documents_lead_created_at_idx" ON "documents" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cases_created_by_user_id_idx" ON "cases" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "cases_assigned_to_idx" ON "cases" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "cases_firm_id_idx" ON "cases" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "analysis_case_created_at_idx" ON "analysis" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "job_queue_status_created_at_idx" ON "job_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_queue_status_started_at_idx" ON "job_queue" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "job_queue_job_type_status_idx" ON "job_queue" USING btree ("job_type","status");--> statement-breakpoint
CREATE INDEX "job_queue_claim_ready_idx" ON "job_queue" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_idx" ON "audit_log" USING btree ("entity_type","occurred_at");--> statement-breakpoint
CREATE INDEX "case_documents_case_id_idx" ON "case_documents" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "fax_results_created_at_idx" ON "fax_results" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "fax_results_status_created_at_idx" ON "fax_results" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "fax_results_lead_id_idx" ON "fax_results" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "review_queue_resolution_created_at_idx" ON "review_queue" USING btree ("resolution","created_at");--> statement-breakpoint
CREATE INDEX "review_queue_entity_idx" ON "review_queue" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "review_queue_created_at_idx" ON "review_queue" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "review_queue_firm_resolution_idx" ON "review_queue" USING btree ("firm_id","resolution","created_at");--> statement-breakpoint
CREATE INDEX "security_alerts_created_at_idx" ON "security_alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "security_alerts_severity_created_at_idx" ON "security_alerts" USING btree ("severity","created_at");--> statement-breakpoint
CREATE INDEX "security_alerts_type_created_at_idx" ON "security_alerts" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "security_alerts_status_created_at_idx" ON "security_alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "integrations_firm_id_idx" ON "integrations" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "integrations_firm_provider_idx" ON "integrations" USING btree ("firm_id","provider");--> statement-breakpoint
CREATE INDEX "lead_background_check_snapshots_lead_id_idx" ON "lead_background_check_snapshots" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_background_check_snapshots_lead_id_created_at_idx" ON "lead_background_check_snapshots" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "document_envelopes_lead_id_idx" ON "document_envelopes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "document_envelopes_lead_status_idx" ON "document_envelopes" USING btree ("lead_id","status");--> statement-breakpoint
CREATE INDEX "document_envelopes_external_id_idx" ON "document_envelopes" USING btree ("external_envelope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_settings_firm_scope_idx" ON "workflow_settings" USING btree ("firm_id","scope");--> statement-breakpoint
CREATE INDEX "workflow_settings_firm_idx" ON "workflow_settings" USING btree ("firm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "firms_slug_idx" ON "firms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "firms_stripe_customer_id_idx" ON "firms" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "firms_stripe_subscription_id_idx" ON "firms" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "firm_invites_token_hash_idx" ON "firm_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "firm_invites_firm_id_idx" ON "firm_invites" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "call_logs_vapi_call_id_idx" ON "call_logs" USING btree ("vapi_call_id");--> statement-breakpoint
CREATE INDEX "call_logs_firm_id_idx" ON "call_logs" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "call_logs_lead_id_idx" ON "call_logs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "call_logs_status_created_at_idx" ON "call_logs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "lead_dispositions_lead_id_idx" ON "lead_dispositions" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "lead_dispositions_firm_id_idx" ON "lead_dispositions" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "lead_dispositions_lead_created_idx" ON "lead_dispositions" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "sms_messages_lead_id_idx" ON "sms_messages" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "sms_messages_firm_id_idx" ON "sms_messages" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "sms_messages_telnyx_message_id_idx" ON "sms_messages" USING btree ("telnyx_message_id");--> statement-breakpoint
CREATE INDEX "sms_messages_external_message_id_idx" ON "sms_messages" USING btree ("external_message_id");--> statement-breakpoint
CREATE INDEX "sms_messages_status_created_at_idx" ON "sms_messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sms_messages_firm_sent_at_idx" ON "sms_messages" USING btree ("firm_id","sent_at");--> statement-breakpoint
CREATE INDEX "admin_dark_room_links_user_idx" ON "admin_dark_room_links" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE INDEX "automation_runs_workflow_idx" ON "automation_runs" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "automation_runs_firm_status_idx" ON "automation_runs" USING btree ("firm_id","status","started_at");--> statement-breakpoint
CREATE INDEX "automation_workflows_firm_idx" ON "automation_workflows" USING btree ("firm_id","updated_at");--> statement-breakpoint
CREATE INDEX "automation_workflows_trigger_idx" ON "automation_workflows" USING btree ("trigger_type","enabled");--> statement-breakpoint
CREATE INDEX "email_events_msg_idx" ON "email_events" USING btree ("external_message_id");--> statement-breakpoint
CREATE INDEX "email_events_provider_idx" ON "email_events" USING btree ("provider","received_at");--> statement-breakpoint
CREATE INDEX "email_events_lead_idx" ON "email_events" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "email_events_firm_idx" ON "email_events" USING btree ("firm_id","received_at");--> statement-breakpoint
CREATE INDEX "fax_events_fax_idx" ON "fax_events" USING btree ("external_fax_id");--> statement-breakpoint
CREATE INDEX "fax_events_provider_idx" ON "fax_events" USING btree ("provider","received_at");--> statement-breakpoint
CREATE INDEX "fax_events_lead_idx" ON "fax_events" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "fax_events_firm_idx" ON "fax_events" USING btree ("firm_id","received_at");--> statement-breakpoint
CREATE INDEX "fasten_connections_lead_idx" ON "fasten_connections" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "fasten_connections_firm_idx" ON "fasten_connections" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "fasten_connections_status_idx" ON "fasten_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "fasten_connections_lead_portal_uniq" ON "fasten_connections" USING btree ("lead_id","portal_id");--> statement-breakpoint
CREATE INDEX "api_key_audit_key_idx" ON "api_key_audit" USING btree ("api_key_id","occurred_at");--> statement-breakpoint
CREATE INDEX "api_key_audit_occurred_idx" ON "api_key_audit" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_firm_idx" ON "api_keys" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "self_heal_sessions_firm_idx" ON "self_heal_sessions" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE INDEX "self_heal_sessions_jules_idx" ON "self_heal_sessions" USING btree ("jules_session_id");--> statement-breakpoint
CREATE INDEX "self_heal_sessions_status_idx" ON "self_heal_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "competitive_intel_advertisers_firm_idx" ON "competitive_intel_advertisers" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitive_intel_advertisers_firm_advid_uniq" ON "competitive_intel_advertisers" USING btree ("firm_id","advertiser_id");--> statement-breakpoint
CREATE INDEX "competitive_intel_snapshots_adv_idx" ON "competitive_intel_snapshots" USING btree ("advertiser_id_fk","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_webhook_events_provider_event_ux" ON "processed_webhook_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "processed_webhook_events_firm_idx" ON "processed_webhook_events" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "processed_webhook_events_first_seen_idx" ON "processed_webhook_events" USING btree ("first_seen_at");