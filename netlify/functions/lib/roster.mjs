import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// STUDENT LIST.  To add new students later, ONLY add names at the END of this
// list (never insert in the middle or reorder - ids/codes follow the position).
// ---------------------------------------------------------------------------
const RAW = [
  'Yasin', 'Ismail', 'Abu Bakar', 'Abdur Rahman', 'Aymaan Khan', 'Muhammad Izaan', 'Abdullah', 'Hameed',
  'Wahaj', 'Alman', 'Maaz Mohammed', 'Saad', 'Ayaan Mirza', 'Rehann', 'Ammar Khan', 'Hamza', 'Ayaan Tonse',
  'Abdul Hameed', 'Affan', 'Zaid Mohammed', 'Jahanzaib Suhail Wani', 'Ayham', 'Ishaq', 'Abdul Wahab', 'Zayan',
  'Fateh', 'Umar Kadiri', 'Ali Kadiri', 'Mufaddal Nazar', 'Muhammed Narmawala', 'Naawed Ahmed',
  'Mohammed Habeeb ur Rehman', 'Mohammed Muzzamil', 'Abdul Majeed Siddiqui', 'Abdullah Qazi', 'Ikram', 'Ammar',
  'Maaz Patel', 'Abdul Rehman', 'Farhan', 'Muhammad Hussain', 'Ismail Shaikh', 'Umar', 'Anas', 'Ali',
  'Abdul Ahad', 'Anas', 'Maaz Nazeem Sheikh', 'Zaid Ejaz', 'Abdur Rehman + Hussain', 'Fouzan',
  'Saiha (Um Khalid)', 'Ibrahim', 'Anas Bari', 'Zeeshan', 'Mohammed Aahil Chohan', 'Sher Hassan', 'Faateh',
  'Talha Faizi', 'Tabraiz', 'Nasr Ullah Baig', 'Nehan Sait', 'Anas', 'Mohammed Sufyan', 'Adil', 'Mudassir',
  'Sultan', 'Sayyad Mohammad Hussain', 'Shaan Bagdadi', 'Arsh', 'Muhammad Adil', 'Aariz', 'Umar', 'Usman',
  'Muhannad', 'Sufyan', 'Ayan', 'Khubaib', 'Sher Mustafa', 'Umar Khan', 'Ismail', 'Yousuf',
];

const norm = (n) => n.trim().replace(/\s+/g, ' ');
const counts = {};
RAW.forEach((n) => { const k = norm(n).toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
const seen = {};

// Students who share the same name get (1), (2), (3) so they can be told apart.
export const STUDENTS = RAW.map((n, i) => {
  const name = norm(n);
  const k = name.toLowerCase();
  let display = name;
  if (counts[k] > 1) { seen[k] = (seen[k] || 0) + 1; display = `${name} (${seen[k]})`; }
  return { id: 's' + String(i + 1).padStart(3, '0'), name: display };
});

// Codes are derived from the server secret (TOKEN_SECRET), so they are stable,
// unique, and never stored in the code repository.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I confusion
let cache = null;
export function allCodes(secret) {
  if (cache && cache.secret === secret) return cache.map;
  const used = new Set();
  const map = {};
  for (const s of STUDENTS) {
    let n = 0, code;
    do {
      const h = crypto.createHmac('sha256', secret).update(`code:${s.id}:${n++}`).digest();
      code = '';
      for (let i = 0; i < 6; i++) code += ALPHABET[h[i] % 32];
    } while (used.has(code));
    used.add(code);
    map[s.id] = code;
  }
  cache = { secret, map };
  return map;
}
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const fmtCode = (c) => c.slice(0, 3) + '-' + c.slice(3);
export const findStudent = (id) => STUDENTS.find((s) => s.id === id);
