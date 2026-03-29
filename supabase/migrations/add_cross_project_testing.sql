-- ═══════════════════════════════════════════════════════════
-- Cross-Project Testing: tables, columns, RLS
-- ═══════════════════════════════════════════════════════════

-- 1. Tests table
CREATE TABLE IF NOT EXISTS tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'completed')),
  winner_variant_id UUID, -- FK added after test_variants exists
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Test variants (join table: test → project variant)
CREATE TABLE IF NOT EXISTS test_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES project_variants(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  label TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add FK for winner_variant_id now that test_variants exists
ALTER TABLE tests
  ADD CONSTRAINT fk_tests_winner_variant
  FOREIGN KEY (winner_variant_id) REFERENCES test_variants(id);

-- 3. Add test_id to analytics_events and leads
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS test_id UUID REFERENCES tests(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS test_id UUID REFERENCES tests(id);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_tests_community ON tests(community_id);
CREATE INDEX IF NOT EXISTS idx_tests_slug ON tests(slug);
CREATE INDEX IF NOT EXISTS idx_test_variants_test ON test_variants(test_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_test ON analytics_events(test_id);
CREATE INDEX IF NOT EXISTS idx_leads_test ON leads(test_id);

-- 5. RLS on tests
ALTER TABLE tests ENABLE ROW LEVEL SECURITY;

-- super_admin: full access
CREATE POLICY "super_admin_tests_all" ON tests
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'super_admin')
  );

-- admin: tests in communities within their org
CREATE POLICY "admin_tests_org" ON tests
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN communities c ON c.id = tests.community_id
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'
        AND c.organization_id = ur.organization_id
    )
  );

-- manager: tests in their community
CREATE POLICY "manager_tests_community" ON tests
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role = 'manager'
        AND community_id = tests.community_id
    )
  );

-- 6. RLS on test_variants (follows test access)
ALTER TABLE test_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "test_variants_via_test" ON test_variants
  FOR ALL USING (
    EXISTS (SELECT 1 FROM tests WHERE tests.id = test_variants.test_id)
  );
