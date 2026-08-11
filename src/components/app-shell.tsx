"use client";

import {
  BookOpen, Braces, ChevronDown, CircleUserRound, CodeXml, Command, Home,
  Languages, ListChecks, LoaderCircle, LogIn, LogOut, Menu, Moon, PanelLeftClose,
  PanelLeftOpen, Settings2, ShieldCheck, Sun, Trophy, X,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Drawer } from "./drawer";
import { IconButton } from "./icon-button";
import { forgeJson, forgeMutation } from "./online-api";
import { Tooltip } from "./tooltip";
import { JUDGE_UI_LOCALE_STORAGE_KEY } from "./judge-ui-i18n";

export type ProductLocale = "en" | "zh-TW";
type ProductTheme = "light" | "dark";
export type ProductSessionStatus = "loading" | "ready" | "error";

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
  readonly sessionStatus: ProductSessionStatus;
  readonly refreshSession: () => Promise<void>;
  readonly setLocale: (locale: ProductLocale) => void;
  readonly toggleTheme: () => void;
}

const ProductContext = createContext<ProductContextValue | null>(null);
const THEME_STORAGE_KEY = "forge:product-theme:v1";
const SIDEBAR_STORAGE_KEY = "forge:sidebar-collapsed:v1";

const LABELS = {
  en: {
    home: "Home", problems: "Problems", contests: "Contests", submissions: "Submissions", profile: "Profile",
    advanced: "Advanced", collections: "Custom collections", organizer: "Organizer", repositories: "Repositories",
    collectionsAdmin: "Collections", contestAdmin: "Contests", rejudges: "Rejudges", applications: "Organizer applications",
    applyOrganizer: "Apply for Organizer", primaryNavigation: "Primary navigation", skip: "Skip to main content",
    openMenu: "Open navigation", closeMenu: "Close navigation", collapseMenu: "Collapse navigation", expandMenu: "Expand navigation",
    signIn: "Sign in with GitHub", signOut: "Sign out", loadingSession: "Checking account…", sessionError: "Could not verify your account.", retry: "Retry",
    light: "Use light theme", dark: "Use dark theme", language: "Change language", student: "Student",
  },
  "zh-TW": {
    home: "首頁", problems: "題庫", contests: "競賽", submissions: "提交紀錄", profile: "個人檔案",
    advanced: "進階", collections: "自訂題庫", organizer: "Organizer", repositories: "Repositories",
    collectionsAdmin: "Collections", contestAdmin: "Contests", rejudges: "Rejudges", applications: "Organizer 申請",
    applyOrganizer: "申請成為 Organizer", primaryNavigation: "主要導覽", skip: "跳至主要內容",
    openMenu: "開啟導覽", closeMenu: "關閉導覽", collapseMenu: "收合導覽", expandMenu: "展開導覽",
    signIn: "使用 GitHub 登入", signOut: "登出", loadingSession: "正在確認帳號…", sessionError: "無法確認帳號狀態。", retry: "重試",
    light: "切換亮色主題", dark: "切換深色主題", language: "切換語言", student: "學生",
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

function NavItem({ href, icon, label, current, close, collapsed }: {
  readonly href: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly current: boolean;
  readonly close: () => void;
  readonly collapsed: boolean;
}) {
  const link = <Link aria-current={current ? "page" : undefined} className={current ? "app-nav-item is-current" : "app-nav-item"} href={href} onClick={close}>{icon}<span>{label}</span></Link>;
  return collapsed ? <Tooltip content={label} placement="right">{link}</Tooltip> : link;
}

function NavGroup({ icon, label, expanded, collapsed, onClick }: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly expanded: boolean;
  readonly collapsed: boolean;
  readonly onClick: () => void;
}) {
  const button = <button className="app-nav-group" type="button" aria-label={collapsed ? label : undefined} aria-expanded={expanded} onClick={onClick}>
    <span>{icon}<span>{label}</span></span>
    <ChevronDown aria-hidden="true" size={14} className={expanded ? "is-open" : ""} />
  </button>;
  return collapsed ? <Tooltip content={label} placement="right">{button}</Tooltip> : button;
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [locale, setLocaleState] = useState<ProductLocale>("en");
  const [theme, setTheme] = useState<ProductTheme>("light");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [session, setSession] = useState<ProductSession>();
  const [sessionStatus, setSessionStatus] = useState<ProductSessionStatus>("loading");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(pathname.startsWith("/collections"));
  const [organizerOpen, setOrganizerOpen] = useState(pathname.startsWith("/organizer"));

  const refreshSession = useCallback(async () => {
    setSessionStatus("loading");
    try {
      setSession(await forgeJson<ProductSession>("/api/auth/session"));
      setSessionStatus("ready");
    } catch {
      setSession(undefined);
      setSessionStatus("error");
    }
  }, []);

  useEffect(() => {
    const resolvedLocale = browserLocale();
    const resolvedTheme = browserTheme();
    queueMicrotask(() => {
      setLocaleState(resolvedLocale);
      setTheme(resolvedTheme);
      setPreferencesReady(true);
      void refreshSession();
    });
  }, [refreshSession]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    const tablet = window.matchMedia("(min-width: 761px) and (max-width: 1023px)");
    const wide = window.matchMedia("(min-width: 1024px)");
    const closeMobile = () => { if (desktop.matches) setMobileOpen(false); };
    const resolveCollapsed = () => {
      if (tablet.matches) setSidebarCollapsed(true);
      else if (wide.matches) setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true");
    };
    closeMobile();
    resolveCollapsed();
    desktop.addEventListener("change", closeMobile);
    tablet.addEventListener("change", resolveCollapsed);
    wide.addEventListener("change", resolveCollapsed);
    return () => {
      desktop.removeEventListener("change", closeMobile);
      tablet.removeEventListener("change", resolveCollapsed);
      wide.removeEventListener("change", resolveCollapsed);
    };
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
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      return next;
    });
  }, []);
  const closeMobileMenu = useCallback(() => setMobileOpen(false), []);
  const context = useMemo<ProductContextValue>(() => ({ locale, theme, session, sessionStatus, refreshSession, setLocale, toggleTheme }), [locale, refreshSession, session, sessionStatus, setLocale, theme, toggleTheme]);
  const text = LABELS[locale];
  const roles = session?.user?.roles ?? [];
  const organizer = roles.includes("organizer") || roles.includes("admin");
  const admin = roles.includes("admin");
  const isCurrent = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  async function signOut() {
    try {
      await forgeMutation("/api/auth/logout", {});
      await refreshSession();
      router.push("/");
      router.refresh();
    } catch {
      setSessionStatus("error");
    }
  }

  function sidebar(close: () => void, collapsed: boolean, mobile: boolean) {
    return <>
      <div className="app-brand">
        <Link href="/" aria-label="Forge" onClick={close}><span className="app-brand-mark"><Command aria-hidden="true" size={17} /></span><strong>Forge</strong></Link>
        <div className="app-brand-actions">
          {mobile
            ? <IconButton icon={X} label={text.closeMenu} onClick={close} />
            : <IconButton icon={collapsed ? PanelLeftOpen : PanelLeftClose} label={collapsed ? text.expandMenu : text.collapseMenu} onClick={toggleSidebar} />}
        </div>
      </div>
      <nav className="app-nav" aria-label={text.primaryNavigation}>
        <NavItem href="/" icon={<Home aria-hidden="true" size={17} />} label={text.home} current={isCurrent("/")} close={close} collapsed={collapsed} />
        <NavItem href="/problems" icon={<BookOpen aria-hidden="true" size={17} />} label={text.problems} current={isCurrent("/problems")} close={close} collapsed={collapsed} />
        <NavItem href="/contests" icon={<Trophy aria-hidden="true" size={17} />} label={text.contests} current={isCurrent("/contests")} close={close} collapsed={collapsed} />
        <NavItem href="/submissions" icon={<ListChecks aria-hidden="true" size={17} />} label={text.submissions} current={isCurrent("/submissions")} close={close} collapsed={collapsed} />
        <NavItem href="/settings/profile" icon={<CircleUserRound aria-hidden="true" size={17} />} label={text.profile} current={isCurrent("/settings/profile")} close={close} collapsed={collapsed} />
        <NavGroup icon={<Settings2 aria-hidden="true" size={17} />} label={text.advanced} expanded={advancedOpen} collapsed={collapsed} onClick={() => setAdvancedOpen((value) => !value)} />
        {advancedOpen && <div className="app-nav-sub">
          <NavItem href="/collections/custom" icon={<Braces aria-hidden="true" size={15} />} label={text.collections} current={isCurrent("/collections/custom")} close={close} collapsed={collapsed} />
        </div>}
        {sessionStatus === "ready" && session?.authenticated && !organizer && <><div className="app-nav-divider" /><NavItem href="/organizer/repositories" icon={<CodeXml aria-hidden="true" size={17} />} label={text.applyOrganizer} current={isCurrent("/organizer")} close={close} collapsed={collapsed} /></>}
        {organizer && <>
          <div className="app-nav-divider" />
          <NavGroup icon={<CodeXml aria-hidden="true" size={17} />} label={text.organizer} expanded={organizerOpen} collapsed={collapsed} onClick={() => setOrganizerOpen((value) => !value)} />
          {organizerOpen && <div className="app-nav-sub">
            <NavItem href="/organizer/repositories" icon={<CodeXml aria-hidden="true" size={15} />} label={text.repositories} current={isCurrent("/organizer/repositories")} close={close} collapsed={collapsed} />
            <NavItem href="/organizer/collections" icon={<BookOpen aria-hidden="true" size={15} />} label={text.collectionsAdmin} current={isCurrent("/organizer/collections")} close={close} collapsed={collapsed} />
            <NavItem href="/organizer/contests" icon={<Trophy aria-hidden="true" size={15} />} label={text.contestAdmin} current={isCurrent("/organizer/contests")} close={close} collapsed={collapsed} />
            <NavItem href="/organizer/rejudges" icon={<ListChecks aria-hidden="true" size={15} />} label={text.rejudges} current={isCurrent("/organizer/rejudges")} close={close} collapsed={collapsed} />
          </div>}
        </>}
        {admin && <><div className="app-nav-divider" /><NavItem href="/admin/organizers" icon={<ShieldCheck aria-hidden="true" size={17} />} label={text.applications} current={isCurrent("/admin/organizers")} close={close} collapsed={collapsed} /></>}
      </nav>
      <div className="app-sidebar-footer">
        <div className="app-preference-row">
          <Tooltip content={text.language} placement="right"><button type="button" aria-label={text.language} onClick={() => setLocale(locale === "en" ? "zh-TW" : "en")}><Languages aria-hidden="true" size={16} /><span>{locale === "en" ? "English" : "繁體中文"}</span></button></Tooltip>
          <IconButton icon={theme === "dark" ? Sun : Moon} label={theme === "dark" ? text.light : text.dark} onClick={toggleTheme} />
        </div>
        {sessionStatus === "loading" && <div className="app-session-status" role="status"><LoaderCircle aria-hidden="true" className="spin" size={16} /><span>{text.loadingSession}</span></div>}
        {sessionStatus === "error" && <div className="app-session-status is-error" role="alert"><span>{text.sessionError}</span><button type="button" onClick={() => void refreshSession()}>{text.retry}</button></div>}
        {sessionStatus === "ready" && (session?.authenticated && session.user
          ? <div className="app-account"><Image src={session.user.avatarUrl} alt="" width={32} height={32} unoptimized /><div><strong>{session.user.login}</strong><span>{roles.length > 0 ? roles.join(" · ") : text.student}</span></div><IconButton icon={LogOut} label={text.signOut} onClick={() => void signOut()} /></div>
          : <a className="app-sign-in" aria-label={text.signIn} href={`/api/auth/github?return=${encodeURIComponent(pathname)}`}><LogIn aria-hidden="true" size={16} /><span>{text.signIn}</span></a>)}
      </div>
    </>;
  }

  if (!preferencesReady || sessionStatus === "loading") {
    return <div className="app-shell app-shell-hydrating" aria-label="Forge" aria-busy="true" role="status"><aside aria-hidden="true" /><div aria-hidden="true" /></div>;
  }

  return <ProductContext.Provider value={context}>
    <div className={sidebarCollapsed ? "app-shell is-sidebar-collapsed" : "app-shell"}>
      <a className="app-skip-link" href="#main-content">{text.skip}</a>
      <aside className="app-sidebar app-sidebar-desktop" data-drawer-background>{sidebar(() => undefined, sidebarCollapsed, false)}</aside>
      <button ref={menuButtonRef} className="app-mobile-menu" type="button" aria-label={text.openMenu} aria-expanded={mobileOpen} aria-controls="mobile-navigation" onClick={() => setMobileOpen(true)} data-drawer-background><Menu aria-hidden="true" size={20} /><span>Forge</span></button>
      <Drawer open={mobileOpen} label={text.primaryNavigation} onClose={closeMobileMenu} returnFocusRef={menuButtonRef} side="left" className="app-sidebar app-sidebar-mobile">
        <div id="mobile-navigation">{sidebar(closeMobileMenu, false, true)}</div>
      </Drawer>
      <div className="app-content" data-drawer-background>{children}</div>
    </div>
  </ProductContext.Provider>;
}
