-- The initial key_holders placeholder was never used as authorization state.
-- Do not silently discard data if an unsupported deployment populated it.
DO $$
BEGIN
  IF to_regclass('public.key_holders') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM key_holders) THEN
      RAISE EXCEPTION
        'Cannot retire non-empty key_holders; migrate its data deliberately before applying migration 012';
    END IF;

    DROP TABLE key_holders;
  END IF;
END $$;
