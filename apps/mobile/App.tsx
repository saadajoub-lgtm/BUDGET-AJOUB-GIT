import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import Constants from "expo-constants";
import { initializeApp, getApps } from "firebase/app";
import { User, getAuth, initializeAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, getFirestore, onSnapshot, query, where } from "firebase/firestore";
import AsyncStorage from "@react-native-async-storage/async-storage";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;

const firebaseConfig = {
  // Keep robust defaults so production APK never boots with empty Firebase config.
  apiKey: extra.firebaseApiKey || "AIzaSyCahRbO0llrtnOrE7-f3vU4XJ5shkG0BKM",
  authDomain: extra.firebaseAuthDomain || "budget-famille-ajoub.firebaseapp.com",
  projectId: extra.firebaseProjectId || "budget-famille-ajoub",
  storageBucket: extra.firebaseStorageBucket || "budget-famille-ajoub.firebasestorage.app",
  messagingSenderId: extra.firebaseMessagingSenderId || "589059942317",
  appId: extra.firebaseAppId || "1:589059942317:web:70eb2302d5f3a616132324"
};

const app = getApps().length ? getApps()[0]! : initializeApp(firebaseConfig);
const rnAuthPersistence = (() => {
  try {
    const mod = require("firebase/auth/react-native");
    return mod?.getReactNativePersistence ? mod.getReactNativePersistence(AsyncStorage) : undefined;
  } catch {
    return undefined;
  }
})();
const auth = (() => {
  try {
    if (rnAuthPersistence) return initializeAuth(app, { persistence: rnAuthPersistence });
    return initializeAuth(app);
  } catch {
    return getAuth(app);
  }
})();
const db = getFirestore(app);
const MOBILE_TABS = ["Dashboard", "Comptes", "Charges", "Ressources", "Historique", "Parametres"] as const;
type MobileTab = (typeof MOBILE_TABS)[number];

type MonthDoc = { id: string; label: string; starts_at?: string };

function toMoney(cents: number) {
  return `${(Number(cents || 0) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DHS`;
}

function useBudgetRealtime(user: User | null) {
  const [month, setMonth] = useState<MonthDoc | null>(null);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [charges, setCharges] = useState<any[]>([]);
  const [histories, setHistories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user?.uid) return;
    const budgetId = `budget-${user.uid}`;
    setLoading(true);
    setError("");
    const monthsRef = collection(db, "budgets", budgetId, "months");
    const unsubMonths = onSnapshot(
      query(monthsRef),
      (snap) => {
        const rows = snap.docs.map((d) => d.data() as any);
        const sorted = rows.sort((a, b) => String(b.starts_at ?? "").localeCompare(String(a.starts_at ?? "")));
        const selected = (sorted[0] as MonthDoc | undefined) ?? null;
        setMonth(selected);
        setLoading(false);
      },
      (e) => {
        setError(String(e?.message ?? "Erreur lecture des mois."));
        setLoading(false);
      }
    );
    return () => unsubMonths();
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid || !month?.id) return;
    const budgetId = `budget-${user.uid}`;
    const unsubAccounts = onSnapshot(query(collection(db, "budgets", budgetId, "accounts"), where("month_id", "==", month.id)), (s) => setAccounts(s.docs.map((d) => d.data())));
    const unsubResources = onSnapshot(query(collection(db, "budgets", budgetId, "resources"), where("month_id", "==", month.id)), (s) => setResources(s.docs.map((d) => d.data())));
    const unsubCharges = onSnapshot(query(collection(db, "budgets", budgetId, "charges"), where("month_id", "==", month.id)), (s) => setCharges(s.docs.map((d) => d.data())));
    const unsubHistory = onSnapshot(query(collection(db, "budgets", budgetId, "histories"), where("month_id", "==", month.id)), (s) => setHistories(s.docs.map((d) => d.data())));
    return () => {
      unsubAccounts();
      unsubResources();
      unsubCharges();
      unsubHistory();
    };
  }, [month?.id, user?.uid]);

  const dashboard = useMemo(() => {
    const soldeActuel = accounts.filter((a) => String(a.name).toUpperCase() !== "EPARGNE").reduce((s, a) => s + Number(a.balance_cents ?? 0), 0);
    const epargne = accounts.filter((a) => String(a.name).toUpperCase() === "EPARGNE").reduce((s, a) => s + Number(a.balance_cents ?? 0), 0);
    const ressourcesAVenir = resources
      .filter((r) => String(r.status ?? "prevue").toLowerCase() === "prevue")
      .reduce((s, r) => s + Math.round(Number(r.amount_cents ?? r.amountCents ?? 0)), 0);
    const chargesAVenir = charges
      .filter(
        (c) =>
          String(c.status ?? "prevue").toLowerCase() === "prevue" &&
          Number(c.paid_cents ?? 0) < Number(c.amount_cents ?? c.amountCents ?? 0)
      )
      .reduce((s, c) => s + Math.max(0, Math.round(Number(c.amount_cents ?? c.amountCents ?? 0)) - Math.round(Number(c.paid_cents ?? 0))), 0);
    const soldeFinMoisPrevu = Math.round(soldeActuel + ressourcesAVenir - chargesAVenir);
    return { soldeActuel, epargne, ressourcesAVenir, chargesAVenir, soldeFinMoisPrevu };
  }, [accounts, charges, resources]);

  return { month, accounts, resources, charges, histories, dashboard, loading, error };
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardValue}>{value}</Text>
    </View>
  );
}

function LoginScreen({ onLogin, error }: { onLogin: (email: string, password: string) => Promise<void>; error: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>Budget C-LIGHT</Text>
      <TextInput placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" style={styles.input} />
      <TextInput placeholder="Mot de passe" value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />
      <TouchableOpacity
        style={styles.primaryBtn}
        onPress={async () => {
          setBusy(true);
          await onLogin(email.trim(), password);
          setBusy(false);
        }}
      >
        <Text style={styles.primaryBtnText}>{busy ? "Connexion..." : "Se connecter"}</Text>
      </TouchableOpacity>
      {!!error && <Text style={styles.error}>{error}</Text>}
    </SafeAreaView>
  );
}

function DashboardScreen({ dashboard }: { dashboard: any }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card title="Solde a jour" value={toMoney(dashboard.soldeActuel)} />
      <Card title="Solde prevu fin de mois" value={toMoney(dashboard.soldeFinMoisPrevu)} />
      <Card title="Epargne" value={toMoney(dashboard.epargne)} />
      <Card title="Ressources a venir" value={toMoney(dashboard.ressourcesAVenir)} />
      <Card title="Charges a venir" value={toMoney(dashboard.chargesAVenir)} />
    </ScrollView>
  );
}

function ListScreen({ title, rows, right }: { title: string; rows: any[]; right: (r: any) => string }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {rows.map((r) => (
        <View key={String(r.id)} style={styles.rowCard}>
          <View>
            <Text style={styles.rowMain}>{String(r.label ?? r.type ?? r.name ?? "Ligne")}</Text>
            <Text style={styles.rowSub}>{String(r.status ?? r.category ?? "")}</Text>
          </View>
          <Text style={styles.rowAmount}>{right(r)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

function SettingsScreen({ email, monthLabel, onLogout }: { email: string; monthLabel: string; onLogout: () => Promise<void> }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card title="Session" value={email || "-"} />
      <Card title="Mois actif" value={monthLabel || "-"} />
      <TouchableOpacity style={styles.secondaryBtn} onPress={() => void onLogout()}>
        <Text style={styles.secondaryBtnText}>Deconnexion</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState("");
  const [activeTab, setActiveTab] = useState<MobileTab>("Dashboard");
  const { month, accounts, resources, charges, histories, dashboard, loading: dataLoading, error: dataError } = useBudgetRealtime(user);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setUser(user ?? null);
      setAuthError("");
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      setAuthError("");
    } catch (e: any) {
      setAuthError(String(e?.message ?? "Connexion impossible."));
    }
  };

  if (loading || (user && dataLoading)) {
    return (
      <SafeAreaView style={styles.loader}>
        <ActivityIndicator size="large" />
      </SafeAreaView>
    );
  }

  if (!user) return <LoginScreen onLogin={login} error={authError} />;

  const monthLabel = String(month?.label ?? "").toUpperCase();
  const currentScreen = (() => {
    if (activeTab === "Dashboard") return <DashboardScreen dashboard={dashboard} />;
    if (activeTab === "Comptes") return <ListScreen title={`Comptes ${monthLabel}`} rows={accounts} right={(r) => toMoney(Number(r.balance_cents ?? 0))} />;
    if (activeTab === "Charges") return <ListScreen title={`Charges ${monthLabel}`} rows={charges} right={(r) => toMoney(Math.max(0, Number(r.amount_cents ?? 0) - Number(r.paid_cents ?? 0)))} />;
    if (activeTab === "Ressources") return <ListScreen title={`Ressources ${monthLabel}`} rows={resources} right={(r) => toMoney(Number(r.amount_cents ?? 0))} />;
    if (activeTab === "Historique") return <ListScreen title={`Historique ${monthLabel}`} rows={histories} right={(r) => toMoney(Number(r.amount_cents ?? 0))} />;
    return <SettingsScreen email={user.email ?? ""} monthLabel={monthLabel} onLogout={() => signOut(auth)} />;
  })();

  return (
    <SafeAreaView style={styles.appRoot}>
      <View style={styles.screenWrap}>{currentScreen}</View>
      <View style={styles.bottomBar}>
        {MOBILE_TABS.map((tab) => (
          <TouchableOpacity key={tab} style={[styles.tabBtn, activeTab === tab ? styles.tabBtnActive : null]} onPress={() => setActiveTab(tab)}>
            <Text style={[styles.tabText, activeTab === tab ? styles.tabTextActive : null]}>{tab}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {!!dataError && (
        <View style={styles.errorBar}>
          <Text style={styles.errorBarText}>{dataError}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  appRoot: { flex: 1, backgroundColor: "#f3f6ff" },
  screenWrap: { flex: 1 },
  bottomBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderColor: "#d7def0",
    backgroundColor: "#ffffff",
    paddingHorizontal: 8,
    paddingVertical: 8
  },
  tabBtn: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10 },
  tabBtnActive: { backgroundColor: "#dfe8ff" },
  tabText: { color: "#53648d", fontWeight: "600", fontSize: 12 },
  tabTextActive: { color: "#17346f", fontWeight: "700" },
  root: { flex: 1, backgroundColor: "#f3f6ff", padding: 20, gap: 12, justifyContent: "center" },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  title: { fontSize: 28, fontWeight: "700", color: "#12244b", marginBottom: 8 },
  input: { borderWidth: 1, borderColor: "#d5ddf1", backgroundColor: "#fff", borderRadius: 12, padding: 12 },
  primaryBtn: { backgroundColor: "#2f66f3", padding: 13, borderRadius: 12 },
  primaryBtnText: { color: "#fff", textAlign: "center", fontWeight: "700" },
  secondaryBtn: { backgroundColor: "#12244b", padding: 13, borderRadius: 12 },
  secondaryBtnText: { color: "#fff", textAlign: "center", fontWeight: "700" },
  content: { padding: 16, gap: 12, backgroundColor: "#f3f6ff" },
  card: { backgroundColor: "#fff", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#e3e9f8" },
  cardTitle: { color: "#4e5f8d", fontWeight: "600", marginBottom: 4 },
  cardValue: { color: "#132a57", fontSize: 20, fontWeight: "700" },
  sectionTitle: { color: "#132a57", fontSize: 20, fontWeight: "700", marginBottom: 4 },
  rowCard: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#e3e9f8", padding: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowMain: { fontSize: 15, fontWeight: "700", color: "#132a57" },
  rowSub: { color: "#617198", marginTop: 2 },
  rowAmount: { color: "#111f44", fontWeight: "700" },
  error: { color: "#c62828" },
  errorBar: { position: "absolute", left: 10, right: 10, bottom: 12, backgroundColor: "#ffe7e7", borderColor: "#f2aaaa", borderWidth: 1, borderRadius: 10, padding: 10 },
  errorBarText: { color: "#9b1c1c", textAlign: "center", fontWeight: "600" }
});
