"use client";

import {
  BookOpen, Braces, ChevronDown, CircleUserRound, CodeXml, Command, Home,
  Languages, ListChecks, LogIn, LogOut, Menu, Moon, Settings2, ShieldCheck,
  Sun, Trophy, X,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { forgeJson, forgeMutation } from "./online-api";
import { JUDGE_UI_LOCALE_STORAGE_KEY } from "./judge-ui-i18n";

export type ProductLocale = "en" | "zh-TW";
type ProductTheme = "light" | "dark";

export interface ProductSession {
  readonly authenticated: boolean;
  readonly user?: {
    readonly login: string;
    readonly avatarUrl: string;
    readonly roles: readonly ("organizer" | "admin")[];
  };
}

interface ProductContextValue {
  readonly locale: ProductLocale;
  readonly theme: ProductTheme;
  readonly session?: ProductSession;
  readonly refreshSession: () => Promise<void>;
  readonly setLocale: (locale: ProductLocale) => void;
  readonly toggleTheme: () => void;
}

const ProductContext = createContext<ProductContextValue | null>(null);
const THEME_STORAGE_KEY = "forge:product-theme:v1";

const LABELS = {
  en: {
    home: "Home", problems: "Problems", contests: "Contests", submissions: "Submissions", profile: "Profile",
    advanced: "Advanced", collections: "Custom collections", organizer: "Organizer", repositories: "Repositories",
    collectionsAdmin: "Collections", contestAdmin: "Contests", rejudges: "Rejudges", applications: "Organizer applications",
    openMenu: "Open navigation", closeMenu: "Close navigation", signIn: "Sign in with GitHub", signOut: "Sign out",
    light: "Use light theme", dark: "Use dark theme", language: "Change language",
  },
  "zh-TW": {
    home: "首頁", problems: "題庫", contests: "競賽", submissions: "提交紀錄", profile: "個人檔案",
    advanced: "進階", collections: "自訂題庫", organizer: "Organizer", repositories: "Repositories",
    collectionsAdmin: "Collections", contestAdmin: "Contests", rejudges: "Rejudges", applications: "Organizer 申請",
    openMenu: "開啟導覽", closeMenu: "關閉導覽", signIn: "使用 GitHub 登入", signOut: "登出",
    light: "切換亮色主題", dark: "切換深色主題", language: "切換語言",
  },
} as const;

function browserLocale(): ProductLocale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(JUDGE_UI_LOCALE_STORAGE_KEY);
  if (stored === "en" || stored === "zh-TW") return stored;
  return window.navigator.language.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

function browserTheme(): ProductTheme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useProduct(): ProductContextValue {
  const value = useContext(ProductContext);
  if (!value) throw new Error("Product context is unavailable.");
  return value;
}

function NavItem({ href, icon, label, current, close }: {
  readonly href: string; readonly icon: ReactNode; readonly label: string; readonly current: boolean; readonly close: () => void;
}) {
  return <Link className={current ? "app-nav-item is-current" : "app-nav-item"} href={href} onClick={close}>{icon}<span>{label}</span></Link>;
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [locale, setLocaleState] = useState<ProductLocale>("en");
  const [theme, setTheme] = useState<ProductTheme>("light");
  const [session, setSession] = useState<ProductSession>();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(pathname.startsWith("/collections"));
  const [organizerOpen, setOrganizerOpen] = useState(pathname.startsWith("/organizer"));

  const refreshSession = useCallback(async () => setSession(await forgeJson<ProductSession>("/api/auth/session")), []);

  useEffect(() => {
    let active = true;
    const resolvedLocale = browserLocale();
    const resolvedTheme = browserTheme();
    queueMicrotask(() => {
      setLocaleState(resolvedLocale);
      setTheme(resolvedTheme);
    });
    void forgeJson<ProductSession>("/api/auth/session")
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession({ authenticated: false }); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh-TW" ? "zh-Hant" : "en";
    document.documentElement.dataset.theme = theme;
  }, [locale, theme]);

  const setLocale = useCallback((value: ProductLocale) => {
    setLocaleState(value);
    window.localStorage.setItem(JUDGE_UI_LOCALE_STORAGE_KEY, value);
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  }, []);
  const context = useMemo<ProductContextValue>(() => ({ locale, theme, session, refreshSession, setLocale, toggleTheme }), [locale, refreshSession, session, setLocale, theme, toggleTheme]);
  const text = LABELS[locale];
  const roles = session?.user?.roles ?? [];
  const organizer = roles.includes("organizer") || roles.includes("admin");
  const admin = roles.includes("admin");
  const close = useCallback(() => setMobileOpen(false), []);
  const isCurrent = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  async function signOut() {
    await forgeMutation("/api/auth/logout", {});
    await refreshSession();
    router.push("/");
    router.refresh();
  }

  return <ProductContext.Provider value={context}>
    <div className="app-shell">
      <button className="app-mobile-menu" type="button" aria-label={text.openMenu} onClick={() => setMobileOpen(true)}><Menu size={20} /><span>Forge</span></button>
      {mobileOpen && <button className="app-sidebar-scrim" type="button" aria-label={text.closeMenu} onClick={close} />}
      <aside className={mobileOpen ? "app-sidebar is-open" : "app-sidebar"} aria-label="Primary navigation">
        <div className="app-brand"><Link href="/" onClick={close}><span className="app-brand-mark"><Command size={17} /></span><strong>Forge</strong></Link><button type="button" aria-label={text.closeMenu} onClick={close}><X size={18} /></button></div>
        <nav className="app-nav">
          <NavItem href="/" icon={<Home size={17} />} label={text.home} current={isCurrent("/")} close={close} />
          <NavItem href="/problems" icon={<BookOpen size={17} />} label={text.problems} current={isCurrent("/problems")} close={close} />
          <NavItem href="/contests" icon={<Trophy size={17} />} label={text.contests} current={isCurrent("/contests")} close={close} />
          <NavItem href="/submissions" icon={<ListChecks size={17} />} label={text.submissions} current={isCurrent("/submissions")} close={close} />
          <NavItem href="/settings/profile" icon={<CircleUserRound size={17} />} label={text.profile} current={isCurrent("/settings/profile")} close={close} />
          <button className="app-nav-group" type="button" onClick={() => setAdvancedOpen((value) => !value)}><span><Settings2 size={17} />{text.advanced}</span><ChevronDown size={14} className={advancedOpen ? "is-open" : ""} /></button>
          {advancedOpen && <div className="app-nav-sub"><NavItem href="/collections/custom" icon={<Braces size={15} />} label={text.collections} current={isCurrent("/collections/custom")} close={close} /></div>}
          {organizer && <>
            <div className="app-nav-divider" />
            <button className="app-nav-group" type="button" onClick={() => setOrganizerOpen((value) => !value)}><span><CodeXml size={17} />{text.organizer}</span><ChevronDown size={14} className={organizerOpen ? "is-open" : ""} /></button>
            {organizerOpen && <div className="app-nav-sub">
              <NavItem href="/organizer/repositories" icon={<CodeXml size={15} />} label={text.repositories} current={isCurrent("/organizer/repositories")} close={close} />
              <NavItem href="/organizer/collections" icon={<BookOpen size={15} />} label={text.collectionsAdmin} current={isCurrent("/organizer/collections")} close={close} />
              <NavItem href="/organizer/contests" icon={<Trophy size={15} />} label={text.contestAdmin} current={isCurrent("/organizer/contests")} close={close} />
              <NavItem href="/organizer/rejudges" icon={<ListChecks size={15} />} label={text.rejudges} current={isCurrent("/organizer/rejudges")} close={close} />
            </div>}
          </>}
          {admin && <><div className="app-nav-divider" /><NavItem href="/admin/organizers" icon={<ShieldCheck size={17} />} label={text.applications} current={isCurrent("/admin/organizers")} close={close} /></>}
        </nav>
        <div className="app-sidebar-footer">
          <div className="app-preference-row">
            <button type="button" title={text.language} onClick={() => setLocale(locale === "en" ? "zh-TW" : "en")}><Languages size={16} /><span>{locale === "en" ? "English" : "繁體中文"}</span></button>
            <button type="button" title={theme === "dark" ? text.light : text.dark} onClick={toggleTheme}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
          </div>
          {session?.authenticated && session.user ? <div className="app-account"><Image src={session.user.avatarUrl} alt="" width={32} height={32} unoptimized /><div><strong>{session.user.login}</strong><span>{roles.length > 0 ? roles.join(" · ") : "Student"}</span></div><button type="button" aria-label={text.signOut} title={text.signOut} onClick={() => void signOut()}><LogOut size={16} /></button></div> : <a className="app-sign-in" href={`/api/auth/github?return=${encodeURIComponent(pathname)}`}><LogIn size={16} />{text.signIn}</a>}
        </div>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  </ProductContext.Provider>;
}
