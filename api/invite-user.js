// POST /api/invite-user
// Body: { email, is_manager }
// Headers: Authorization: Bearer <access_token>
//
// 1. Verify caller is a manager (check user_profiles)
// 2. Create user via Supabase admin API (auth.admin.createUser)
// 3. Create user_profiles row with is_manager flag
// 4. Return success

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const accessToken = authHeader.replace('Bearer ', '');

  try {
    // 1. Verify caller identity
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

    // 2. Check caller is a manager
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
      return res.status(403).json({ error: 'Only managers can invite users' });
    }

    // 3. Parse request body
    const { email, is_manager } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // 4. Create user via Supabase Admin API
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        email,
        email_confirm: true,
        password: generateTempPassword()
      })
    });

    if (!createRes.ok) {
      const errData = await createRes.json();
      return res.status(400).json({ error: errData.msg || errData.message || 'Failed to create user' });
    }
    const newUser = await createRes.json();

    // 5. Create user_profiles row
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        user_id: newUser.id,
        is_manager: !!is_manager
      })
    });

    if (!insertRes.ok) {
      const errData = await insertRes.json();
      console.error('Profile insert error:', errData);
      // User was created but profile failed — not fatal
    }

    return res.status(200).json({
      success: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        is_manager: !!is_manager
      }
    });

  } catch (err) {
    console.error('invite-user error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  let pass = '';
  for (let i = 0; i < 16; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass;
}
