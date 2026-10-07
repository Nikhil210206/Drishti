/**
 * The welcome flow's words. English and hand-written Hindi here; the other nine languages are
 * machine-translated (Sarvam Mayura) once Drishti is connected, cached, and marked as such.
 * Everything here is fixed text: no user data is ever translated.
 */
export const STRINGS = {
  langTitle: { en: "Choose your language", hi: "अपनी भाषा चुनिए" },
  langIntro: {
    en: "Welcome to Drishti. Choose the language you want Drishti to speak. Use Tab to move between languages and Enter to choose.",
    hi: "Drishti में आपका स्वागत है। वह भाषा चुनिए जिसमें Drishti बोले। भाषाओं के बीच जाने के लिए Tab, चुनने के लिए Enter दबाइए।",
  },
  connectTitle: { en: "Connect Drishti", hi: "Drishti जोड़िए" },
  connectIntro: {
    en: "Drishti needs to connect once. Press Connect: a page opens, checks that you are a person, usually with nothing to do, and closes by itself.",
    hi: "Drishti को एक बार जोड़ना होगा। Connect दबाइए: एक पेज खुलेगा, जाँचेगा कि आप इंसान हैं, आम तौर पर कुछ करना नहीं पड़ता, और अपने आप बंद हो जाएगा।",
  },
  connect: { en: "Connect", hi: "जोड़िए" },
  connected: { en: "Drishti is connected.", hi: "Drishti जुड़ गया।" },
  waiting: { en: "Waiting for the connect page…", hi: "Connect पेज का इंतज़ार…" },
  consentTitle: { en: "Your privacy", hi: "आपकी निजता" },
  consentIntro: {
    en: "Before Drishti hears or reads anything, here is what it does with your data.",
    hi: "Drishti कुछ भी सुने या पढ़े, उससे पहले जानिए कि वह आपके डेटा का क्या करता है।",
  },
  consent1: {
    en: "While you talk to Drishti, your voice, your request and the page you ask about go to Sarvam AI, an Indian company, to understand you and to speak. Drishti's relay passes them on and keeps nothing.",
    hi: "जब आप Drishti से बात करते हैं, आपकी आवाज़, आपकी बात और वह पेज जिसके बारे में आप पूछते हैं, आपको समझने और बोलने के लिए Sarvam AI (एक भारतीय कंपनी) को जाते हैं। Drishti का रिले उन्हें आगे भेजता है और कुछ नहीं रखता।",
  },
  consent2: {
    en: "Your settings and your saved name, age and phone number stay on this computer. Say “delete my details” at any time to remove them.",
    hi: "आपकी सेटिंग्स और सेव किया हुआ नाम, उम्र और फ़ोन नंबर इसी कंप्यूटर पर रहते हैं। उन्हें हटाने के लिए कभी भी “मेरी जानकारी मिटा दो” बोलिए।",
  },
  consent3: {
    en: "Drishti never types passwords, OTPs or card numbers, and never pays, books or sends anything without your spoken yes.",
    hi: "Drishti कभी पासवर्ड, OTP या कार्ड नंबर टाइप नहीं करता, और आपकी 'हाँ' के बिना कभी पैसे नहीं देता, बुक नहीं करता, कुछ नहीं भेजता।",
  },
  agree: { en: "I agree", hi: "मैं सहमत हूँ" },
  fullPolicy: { en: "Read the full privacy page", hi: "पूरा प्राइवेसी पेज पढ़िए" },
  micTitle: { en: "Your microphone", hi: "आपका माइक्रोफ़ोन" },
  micIntro: {
    en: "Press Allow microphone. When Chrome asks, choose “Allow while visiting the site”. Then hold the Test button, or the Space bar, say something, and let go.",
    hi: "Allow microphone दबाइए। जब Chrome पूछे, “Allow while visiting the site” चुनिए। फिर Test बटन या Space दबाकर रखिए, कुछ बोलिए, और छोड़ दीजिए।",
  },
  allowMic: { en: "Allow microphone", hi: "माइक्रोफ़ोन की अनुमति दीजिए" },
  micAllowed: { en: "Microphone allowed.", hi: "माइक्रोफ़ोन की अनुमति मिल गई।" },
  micDenied: {
    en: "The microphone is not allowed. Press Allow microphone again and choose “Allow while visiting the site”.",
    hi: "माइक्रोफ़ोन की अनुमति नहीं मिली। फिर से Allow microphone दबाइए और “Allow while visiting the site” चुनिए।",
  },
  holdToTest: { en: "Hold to test", hi: "टेस्ट के लिए दबाकर रखिए" },
  listening: { en: "Listening…", hi: "सुन रहा हूँ…" },
  heard: { en: "I heard:", hi: "मैंने सुना:" },
  voiceTitle: { en: "Drishti's voice", hi: "Drishti की आवाज़" },
  voiceIntro: {
    en: "Choose a voice and how fast Drishti speaks, then press Play sample. You can change these later.",
    hi: "आवाज़ और बोलने की रफ़्तार चुनिए, फिर Play sample दबाइए। इन्हें बाद में बदल सकते हैं।",
  },
  voice: { en: "Voice", hi: "आवाज़" },
  speed: { en: "Speed", hi: "रफ़्तार" },
  playSample: { en: "Play sample", hi: "नमूना सुनिए" },
  sample: {
    en: "Hello, I'm Drishti. I will read pages and fill forms for you.",
    hi: "नमस्ते, मैं दृष्टि हूँ। मैं आपके लिए पेज पढ़ूँगी और फ़ॉर्म भरूँगी।",
  },
  profileTitle: { en: "Your details (optional)", hi: "आपकी जानकारी (ज़रूरी नहीं)" },
  profileIntro: {
    en: "If you like, save your name, age, gender and phone number, so Drishti can fill booking forms for you. They stay on this computer. You can skip this.",
    hi: "चाहें तो अपना नाम, उम्र, लिंग और फ़ोन नंबर सेव कीजिए, ताकि Drishti बुकिंग फ़ॉर्म भर सके। ये इसी कंप्यूटर पर रहते हैं। इसे छोड़ भी सकते हैं।",
  },
  name: { en: "Name", hi: "नाम" },
  age: { en: "Age", hi: "उम्र" },
  gender: { en: "Gender", hi: "लिंग" },
  female: { en: "Female", hi: "महिला" },
  male: { en: "Male", hi: "पुरुष" },
  transgender: { en: "Transgender", hi: "ट्रांसजेंडर" },
  mobile: { en: "Mobile number", hi: "मोबाइल नंबर" },
  save: { en: "Save", hi: "सेव कीजिए" },
  skip: { en: "Skip", hi: "छोड़िए" },
  next: { en: "Next", hi: "आगे" },
  practiceTitle: { en: "Try it", hi: "आज़माइए" },
  practiceIntro: {
    en: "Drishti is ready. Press Start practice: a practice train-booking site opens with Drishti beside it. Hold Space and say, for example, “show trains from Chennai to Bengaluru tomorrow”. Nothing there is real.",
    hi: "Drishti तैयार है। Start practice दबाइए: अभ्यास के लिए ट्रेन बुकिंग की साइट खुलेगी और साथ में Drishti। Space दबाकर बोलिए, जैसे “कल चेन्नई से बेंगलुरु की ट्रेनें दिखाओ”। वहाँ कुछ भी असली नहीं है।",
  },
  startPractice: { en: "Start practice", hi: "अभ्यास शुरू कीजिए" },
  machine: { en: "This page was machine-translated from English.", hi: "" },
} as const;

export type StringKey = keyof typeof STRINGS;
