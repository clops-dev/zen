-- Migration 015: Subscription price and wallet financial tracking.

BEGIN;

-- Add subscription_price_usd column to subscriptions table with 6 decimal places default
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS subscription_price_usd NUMERIC(14,6) NOT NULL DEFAULT 0.000000;

-- Backfill default prices for existing subscription tiers if subscription_price_usd is 0
UPDATE subscriptions
  SET subscription_price_usd = 20.000000
WHERE tier = 'pro' AND subscription_price_usd = 0.000000;

UPDATE subscriptions
  SET subscription_price_usd = 100.000000
WHERE tier = 'enterprise' AND subscription_price_usd = 0.000000;

COMMIT;
