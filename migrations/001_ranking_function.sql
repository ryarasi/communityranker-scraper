-- Compute community score with weighted factors
-- Weights: age 0.20, size 0.25, activity 0.25, access 0.10, reputation 0.10, freshness 0.10

CREATE OR REPLACE FUNCTION compute_community_score(community_uuid UUID)
RETURNS NUMERIC AS $$
DECLARE
  age_score NUMERIC;
  size_score NUMERIC;
  activity_score NUMERIC;
  access_score NUMERIC;
  reputation_score NUMERIC;
  freshness_score NUMERIC;
  total_score NUMERIC;
  rec RECORD;
BEGIN
  SELECT
    c.id,
    c.access_model,
    c.created_at,
    c.freshness_score AS fs,
    cp.founded_year,
    cm.member_count,
    cm.activity_level
  INTO rec
  FROM communities c
  LEFT JOIN community_profiles cp ON cp.community_id = c.id
  LEFT JOIN LATERAL (
    SELECT member_count, activity_level
    FROM community_metrics
    WHERE community_id = c.id
    ORDER BY measured_at DESC
    LIMIT 1
  ) cm ON true
  WHERE c.id = community_uuid;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Age score: older communities score higher, max at 10 years
  IF rec.founded_year IS NOT NULL THEN
    age_score := LEAST((EXTRACT(YEAR FROM NOW()) - rec.founded_year) / 10.0, 1.0);
  ELSE
    age_score := 0.3; -- default for unknown age
  END IF;

  -- Size score: logarithmic scale, max at 1M members
  IF rec.member_count IS NOT NULL AND rec.member_count > 0 THEN
    size_score := LEAST(LOG(rec.member_count) / LOG(1000000), 1.0);
  ELSE
    size_score := 0;
  END IF;

  -- Activity score based on activity level enum
  activity_score := CASE rec.activity_level
    WHEN 'very_active' THEN 1.0
    WHEN 'active' THEN 0.8
    WHEN 'moderate' THEN 0.5
    WHEN 'low' THEN 0.2
    WHEN 'inactive' THEN 0.0
    ELSE 0.3 -- unknown
  END;

  -- Access score: more open = higher
  access_score := CASE rec.access_model
    WHEN 'open' THEN 1.0
    WHEN 'hybrid' THEN 0.7
    WHEN 'approval_required' THEN 0.5
    WHEN 'paid' THEN 0.3
    WHEN 'invite_only' THEN 0.2
    ELSE 0.5
  END;

  -- Reputation score: placeholder based on age and size
  reputation_score := (COALESCE(age_score, 0) + COALESCE(size_score, 0)) / 2.0;

  -- Freshness score from stored value (0-1)
  freshness_score := COALESCE(rec.fs, 0.5);

  -- Weighted total
  total_score := (
    age_score * 0.20 +
    size_score * 0.25 +
    activity_score * 0.25 +
    access_score * 0.10 +
    reputation_score * 0.10 +
    freshness_score * 0.10
  );

  RETURN ROUND(total_score, 4);
END;
$$ LANGUAGE plpgsql STABLE;
