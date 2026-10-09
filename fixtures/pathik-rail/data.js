// Pathik Rail mock data — fictional operator, deterministic trains for any station pair.
export const STATIONS = [
  ["MAS", "Chennai Central", "Chennai", 13.08, 80.27],
  ["MS", "Chennai Egmore", "Chennai", 13.08, 80.26],
  ["SBC", "KSR Bengaluru", "Bengaluru", 12.98, 77.57],
  ["YPR", "Yesvantpur Junction", "Bengaluru", 13.02, 77.55],
  ["NDLS", "New Delhi", "Delhi", 28.64, 77.22],
  ["CSMT", "Mumbai CSMT", "Mumbai", 18.94, 72.84],
  ["LTT", "Lokmanya Tilak Terminus", "Mumbai", 19.07, 72.89],
  ["HWH", "Howrah Junction", "Kolkata", 22.58, 88.34],
  ["SDAH", "Sealdah", "Kolkata", 22.57, 88.37],
  ["SC", "Secunderabad Junction", "Hyderabad", 17.43, 78.5],
  ["HYB", "Hyderabad Deccan", "Hyderabad", 17.39, 78.47],
  ["PUNE", "Pune Junction", "Pune", 18.53, 73.87],
  ["ADI", "Ahmedabad Junction", "Ahmedabad", 23.03, 72.6],
  ["JP", "Jaipur Junction", "Jaipur", 26.92, 75.79],
  ["LKO", "Lucknow Charbagh", "Lucknow", 26.83, 80.92],
  ["PNBE", "Patna Junction", "Patna", 25.6, 85.14],
  ["BBS", "Bhubaneswar", "Bhubaneswar", 20.27, 85.84],
  ["TVC", "Thiruvananthapuram Central", "Thiruvananthapuram", 8.49, 76.95],
  ["ERS", "Ernakulam Junction", "Kochi", 9.97, 76.29],
  ["CBE", "Coimbatore Junction", "Coimbatore", 10.99, 76.96],
  ["MDU", "Madurai Junction", "Madurai", 9.92, 78.12],
  ["MYS", "Mysuru Junction", "Mysuru", 12.32, 76.65],
  ["BZA", "Vijayawada Junction", "Vijayawada", 16.52, 80.62],
  ["VSKP", "Visakhapatnam", "Visakhapatnam", 17.72, 83.29],
  ["NGP", "Nagpur Junction", "Nagpur", 21.15, 79.09],
  ["BPL", "Bhopal Junction", "Bhopal", 23.27, 77.41],
  ["GHY", "Guwahati", "Guwahati", 26.18, 91.75],
  ["ASR", "Amritsar Junction", "Amritsar", 31.63, 74.87],
  ["CDG", "Chandigarh", "Chandigarh", 30.7, 76.82],
  ["BSB", "Varanasi Junction", "Varanasi", 25.33, 82.99],
  // More cities, so people practising can book from and to their own (a Tamil user's first try was Erode).
  ["ED", "Erode Junction", "Erode", 11.33, 77.72],
  ["SA", "Salem Junction", "Salem", 11.67, 78.13],
  ["TPJ", "Tiruchirappalli Junction", "Tiruchirappalli", 10.8, 78.69],
  ["TEN", "Tirunelveli Junction", "Tirunelveli", 8.73, 77.71],
  ["CAPE", "Kanniyakumari", "Kanniyakumari", 8.08, 77.55],
  ["TJ", "Thanjavur Junction", "Thanjavur", 10.78, 79.13],
  ["KPD", "Katpadi Junction", "Vellore", 12.97, 79.14],
  ["TUP", "Tiruppur", "Tiruppur", 11.11, 77.34],
  ["CLT", "Kozhikode", "Kozhikode", 11.25, 75.78],
  ["TCR", "Thrissur", "Thrissur", 10.52, 76.21],
  ["QLN", "Kollam Junction", "Kollam", 8.89, 76.6],
  ["MAQ", "Mangaluru Central", "Mangaluru", 12.86, 74.84],
  ["UBL", "Hubballi Junction", "Hubballi", 15.35, 75.15],
  ["MAO", "Madgaon", "Goa", 15.27, 73.97],
  ["TPTY", "Tirupati", "Tirupati", 13.63, 79.42],
  ["GNT", "Guntur Junction", "Guntur", 16.3, 80.44],
  ["WL", "Warangal", "Warangal", 17.97, 79.6],
  ["AGC", "Agra Cantt", "Agra", 27.16, 77.99],
  ["CNB", "Kanpur Central", "Kanpur", 26.45, 80.35],
  ["PRYJ", "Prayagraj Junction", "Prayagraj", 25.44, 81.83],
  ["GKP", "Gorakhpur Junction", "Gorakhpur", 26.76, 83.37],
  ["DDN", "Dehradun", "Dehradun", 30.32, 78.03],
  ["HW", "Haridwar Junction", "Haridwar", 29.95, 78.16],
  ["JAT", "Jammu Tawi", "Jammu", 32.71, 74.88],
  ["LDH", "Ludhiana Junction", "Ludhiana", 30.91, 75.85],
  ["AJ", "Ajmer Junction", "Ajmer", 26.46, 74.63],
  ["JU", "Jodhpur Junction", "Jodhpur", 26.28, 73.02],
  ["UDZ", "Udaipur City", "Udaipur", 24.57, 73.7],
  ["INDB", "Indore Junction", "Indore", 22.72, 75.87],
  ["GWL", "Gwalior Junction", "Gwalior", 26.22, 78.18],
  ["R", "Raipur Junction", "Raipur", 21.26, 81.63],
  ["RNC", "Ranchi Junction", "Ranchi", 23.35, 85.32],
  ["GAYA", "Gaya Junction", "Gaya", 24.8, 85.0],
  ["NJP", "New Jalpaiguri", "Siliguri", 26.68, 88.44],
  ["PURI", "Puri", "Puri", 19.81, 85.83],
  ["CTC", "Cuttack", "Cuttack", 20.46, 85.88],
  ["ST", "Surat", "Surat", 21.21, 72.84],
  ["BRC", "Vadodara Junction", "Vadodara", 22.31, 73.18],
  ["RJT", "Rajkot Junction", "Rajkot", 22.3, 70.8],
  ["NK", "Nashik Road", "Nashik", 19.95, 73.84],
  ["AWB", "Aurangabad", "Aurangabad", 19.88, 75.34],
  ["KOP", "Kolhapur", "Kolhapur", 16.7, 74.24],
  ["SUR", "Solapur Junction", "Solapur", 17.66, 75.91],
].map(([code, name, city, lat, lon]) => ({ code, name, city, lat, lon }));

export const CLASSES = [
  { code: "SL", name: "Sleeper (SL)", perKm: 0.46, min: 145 },
  { code: "3A", name: "AC 3 Tier (3A)", perKm: 1.18, min: 380 },
  { code: "2A", name: "AC 2 Tier (2A)", perKm: 1.72, min: 560 },
  { code: "1A", name: "AC First Class (1A)", perKm: 2.85, min: 940 },
  { code: "2S", name: "Second Sitting (2S)", perKm: 0.26, min: 90 },
  { code: "CC", name: "AC Chair Car (CC)", perKm: 0.95, min: 310 },
];

export const QUOTAS = [
  { code: "GN", name: "General" },
  { code: "TQ", name: "Tatkal" },
  { code: "LD", name: "Ladies" },
  { code: "SS", name: "Senior Citizen" },
];

export const station = (code) => STATIONS.find((s) => s.code === code);

function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distanceKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.max(60, Math.round(2 * R * Math.asin(Math.sqrt(x)) * 1.25));
}

const TYPES = [
  ["Shatabdi Express", "day", ["CC", "2S"], 1.25],
  ["Vande Bharat Express", "day", ["CC"], 1.35],
  ["Mail", "night", ["SL", "3A", "2A", "1A"], 1.0],
  ["Superfast Express", "any", ["SL", "3A", "2A"], 1.1],
  ["Express", "any", ["SL", "3A", "2A", "2S"], 0.95],
  ["Intercity Express", "day", ["2S", "CC"], 1.05],
  ["Humsafar Express", "night", ["3A"], 1.15],
  ["Double Decker Express", "day", ["CC"], 1.2],
  ["Sampark Kranti Express", "night", ["SL", "3A", "2A"], 1.05],
  ["Garib Rath Express", "night", ["3A"], 1.05],
];
const NAMES = ["Kaveri", "Brindavan", "Lalbagh", "Nilgiri", "Charminar", "Godavari", "Ganga", "Konark", "Sahyadri", "Malabar", "Pearl City", "Vaigai", "Rajdhani", "Tapti", "Narmada"];

const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (mins) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;

export function trainsFor(from, to, date) {
  const a = station(from), b = station(to);
  if (!a || !b || from === to) return [];
  const km = distanceKm(a, b);
  const r = rng(`${from}-${to}`);
  const count = 9 + Math.floor(r() * 4);
  const trains = [];
  for (let i = 0; i < count; i++) {
    const [type, when, classes, speedF] = TYPES[Math.floor(r() * TYPES.length)];
    const dep = when === "night" ? 18 * 60 + Math.floor(r() * 300) : when === "day" ? 5 * 60 + Math.floor(r() * 600) : Math.floor(r() * 1440);
    const depR = dep - (dep % 5);
    const speed = 52 * speedF + r() * 12;
    const dur = Math.round((km / speed) * 60 / 5) * 5;
    const base = r() < 0.5 ? `${a.city}–${b.city}` : NAMES[Math.floor(r() * NAMES.length)];
    const no = String([12, 16, 22, 20, 11][Math.floor(r() * 5)] * 1000 + Math.floor(r() * 999)).padStart(5, "0");
    const ar = rng(`${no}-${date}`);
    trains.push({
      no,
      name: `${base} ${type}`,
      dep: fmtTime(depR),
      arr: fmtTime(depR + dur),
      depMins: depR,
      duration: `${Math.floor(dur / 60)}h ${pad(dur % 60)}m`,
      nextDay: depR + dur >= 1440,
      km,
      classes: classes.map((code) => {
        const c = CLASSES.find((x) => x.code === code);
        const fare = Math.max(c.min, Math.round((km * c.perKm * speedF) / 5) * 5);
        const roll = ar();
        const status = roll < 0.55 ? "AVL" : roll < 0.72 ? "RAC" : "WL";
        const n = status === "AVL" ? 1 + Math.floor(ar() * 120) : 1 + Math.floor(ar() * 60);
        return { code, fare, status, n };
      }),
    });
  }
  return trains.sort((x, y) => x.depMins - y.depMins);
}

export function findTrain(from, to, date, no) {
  return trainsFor(from, to, date).find((t) => t.no === no);
}
