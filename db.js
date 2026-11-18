// Supabase mijozi (faqat server tomonda! service_role kaliti brauzerga chiqmasligi kerak)
const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
  throw new Error(".env faylida SUPABASE_URL va SUPABASE_SERVICE_KEY ni kiriting");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Supabase javobidan xatoni tashlab, ma'lumotni qaytaradi
const must = ({ data, error }) => { if (error) throw error; return data; };

module.exports = { sb, must };
