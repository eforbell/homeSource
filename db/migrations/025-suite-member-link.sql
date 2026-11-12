-- Home Base suite identity (Feature-10): the household member each Home Source member is, linked by a parent in
-- tailnet mode. Nullable, so local mode and unlinked members are untouched; unique, so one household member is one
-- Home Source member.

ALTER TABLE family_members ADD COLUMN IF NOT EXISTS suite_member_id TEXT UNIQUE;
