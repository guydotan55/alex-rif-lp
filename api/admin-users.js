// GET  /api/admin-users — returns all users with profiles
// PATCH /api/admin-users — updates manager status { user_id, is_manager }
// Headers: Authorization: Bearer <access_token>

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const accessToken = authHeader.replace('Bearer ', '');

  try {
    // Verify caller identity
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY
      }
    });
    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid access token' });
    }
    const callerUser = await userRes.json();

    // Check caller is a manager
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${callerUser.id}&select=is_manager`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    const profiles = await profileRes.json();
    if (!profiles.length || !profiles[0].is_manager) {
      return res.status(403).json({ error: 'Only managers can access user management' });
    }

    if (req.method === 'GET') {
      return await handleGet(res);
    } else if (req.method === 'PATCH') {
      return await handlePatch(req, res);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

  } catch (err) {
    console.error('admin-users error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(res) {
  // Fetch all auth users via admin API
  const usersRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=500`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if (!usersRes.ok) {
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
  const usersData = await usersRes.json();
  const authUsers = usersData.users || usersData || [];

  // Fetch all user_profiles
  const profilesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?select=*`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  const allProfiles = await profilesRes.json();
  const profileMap = {};
  (allProfiles || []).forEach(p => { profileMap[p.user_id] = p; });

  // Fetch project counts per user
  const projectsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?select=user_id`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  const allProjectRows = await projectsRes.json();
  const projectCounts = {};
  (allProjectRows || []).forEach(p => {
    if (p.user_id) {
      projectCounts[p.user_id] = (projectCounts[p.user_id] || 0) + 1;
    }
  });

  // Merge data
  const users = authUsers.map(u => ({
    id: u.id,
    email: u.email,
    is_manager: profileMap[u.id]?.is_manager || false,
    has_profile: !!profileMap[u.id],
    created_at: u.created_at,
    projects_count: projectCounts[u.id] || 0
  }));

  return res.status(200).json({ users });
}

async function handlePatch(req, res) {
  const { user_id, is_manager } = req.body || {};
  if (!user_id || typeof is_manager !== 'boolean') {
    return res.status(400).json({ error: 'user_id and is_manager (boolean) are required' });
  }

  // Check if profile exists
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${user_id}&select=id`,
    {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  const existing = await checkRes.json();

  if (existing.length > 0) {
    // Update existing profile
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${user_id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ is_manager })
      }
    );
    if (!updateRes.ok) {
      const errData = await updateRes.json();
      return res.status(500).json({ error: errData.message || 'Failed to update profile' });
    }
  } else {
    // Insert new profile
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ user_id, is_manager })
    });
    if (!insertRes.ok) {
      const errData = await insertRes.json();
      return res.status(500).json({ error: errData.message || 'Failed to create profile' });
    }
  }

  return res.status(200).json({ success: true });
}
