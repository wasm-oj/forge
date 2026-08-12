"use client";

import { ExternalLink, GitBranch, Trash2, TriangleAlert, UserRound, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Drawer } from "../../../components/ui/drawer";
import { IconButton } from "../../../components/ui/icon-button";
import { RemoteStateView, type RemoteState } from "../../../components/ui/remote-state";
import type { Profile } from "../../catalog/model/education-model";
import { wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";
import { useProduct } from "../../platform/components/app-shell";
import { usePageTitle } from "../../platform/hooks/page-title";

interface AccountErasureResponse {
  readonly erased: boolean;
  readonly queued?: boolean;
}

const TEXT = {
  en: {
    eyebrow: "Account", title: "Profile settings", intro: "Choose what other learners can see and manage your account.",
    loading: "Loading profile…", retry: "Retry", signIn: "Sign in with GitHub", signInDetail: "Sign in to edit your profile and account.",
    displayName: "Display name", bio: "Bio", website: "Website", visibility: "Profile visibility", public: "Public", private: "Private",
    save: "Save profile", saving: "Saving…", saved: "Profile saved.", publicProfile: "View public profile", verified: "verified solved",
    dangerTitle: "Delete account", dangerDetail: "Permanently remove your WASM-OJ account and anonymize server submissions.", delete: "Delete account",
    confirmTitle: "Permanently delete account?", confirmDetail: "Access is revoked immediately. Server submissions are anonymized and remote source archives are removed. Drafts stored in this browser remain on this device.",
    typeLogin: "Type your GitHub login to confirm", cancel: "Cancel", deleting: "Deleting…", close: "Close account deletion",
    deleted: "Your WASM-OJ account was deleted and you have been signed out.", queued: "Account deletion started. Access has been revoked and remaining archives will be removed shortly.",
  },
  "zh-TW": {
    eyebrow: "帳號", title: "個人檔案設定", intro: "決定其他學習者能看到的資料，並管理你的帳號。",
    loading: "正在載入個人檔案…", retry: "重試", signIn: "使用 GitHub 登入", signInDetail: "登入後才能編輯個人檔案與帳號。",
    displayName: "顯示名稱", bio: "自我介紹", website: "網站", visibility: "個人檔案可見度", public: "公開", private: "私人",
    save: "儲存個人檔案", saving: "正在儲存…", saved: "個人檔案已儲存。", publicProfile: "查看公開個人檔案", verified: "題正式解題",
    dangerTitle: "刪除帳號", dangerDetail: "永久刪除 WASM-OJ 帳號，並匿名化 Server 提交紀錄。", delete: "刪除帳號",
    confirmTitle: "要永久刪除帳號嗎？", confirmDetail: "帳號存取權會立刻撤銷；Server 提交會匿名化，遠端程式碼封存會移除。這台裝置瀏覽器內的草稿仍會保留。",
    typeLogin: "輸入 GitHub login 以確認", cancel: "取消", deleting: "正在刪除…", close: "關閉刪除帳號視窗",
    deleted: "WASM-OJ 帳號已刪除，並已登出。", queued: "帳號刪除已開始，存取權已撤銷；其餘封存資料會隨後移除。",
  },
} as const;

export function ProfileSettings() {
  const { locale, session, sessionStatus, refreshSession } = useProduct();
  const text = TEXT[locale];
  const [profileState, setProfileState] = useState<RemoteState<Profile>>({ status: "loading" });
  const [saveMessage, setSaveMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [erasureMessage, setErasureMessage] = useState("");
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteInputRef = useRef<HTMLInputElement>(null);
  usePageTitle(text.title);

  const loadProfile = useCallback(async () => {
    setProfileState({ status: "loading" });
    try {
      const value = await wasmOjJson<{ profile: Profile }>("/api/profile");
      setProfileState({ status: "ready", data: value.profile });
    } catch (reason) {
      setProfileState({
        status: "error",
        message: reason instanceof Error ? reason.message : String(reason),
        retry: () => void loadProfile(),
      });
    }
  }, []);

  useEffect(() => {
    if (sessionStatus === "ready" && session?.authenticated) void loadProfile();
  }, [loadProfile, session?.authenticated, sessionStatus]);

  const closeDelete = useCallback(() => {
    if (deleting) return;
    setDeleteOpen(false);
    setDeleteConfirmation("");
    setDeleteError("");
  }, [deleting]);

  function updateProfile(update: Partial<Profile>) {
    setProfileState((current) => current.status === "ready" ? { ...current, data: { ...current.data, ...update } } : current);
  }

  async function save(event: FormEvent<HTMLFormElement>, profile: Profile) {
    event.preventDefault();
    setSaving(true);
    setSaveMessage("");
    try {
      await wasmOjMutation("/api/profile", {
        displayName: profile.displayName,
        bio: profile.bio,
        websiteUrl: profile.websiteUrl ?? undefined,
        visibility: profile.visibility,
      }, "PATCH");
      setSaveMessage(text.saved);
    } catch (reason) {
      setSaveMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function deleteAccount(profile: Profile) {
    if (deleteConfirmation !== profile.login) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = await wasmOjMutation<AccountErasureResponse>("/api/account", {}, "DELETE");
      setErasureMessage(result.erased ? text.deleted : text.queued);
      setDeleteOpen(false);
      await refreshSession();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(false);
    }
  }

  if (erasureMessage) return <main className="product-page narrow-page" id="main-content"><section className="account-erasure-complete" role="status"><UserRound aria-hidden="true" size={28} /><h1>{erasureMessage}</h1><Link className="primary-action" href="/">WASM-OJ</Link></section></main>;

  return <main className="product-page narrow-page" id="main-content">
    <header className="product-page-header"><span className="product-eyebrow"><UserRound aria-hidden="true" size={14} /> {text.eyebrow}</span><h1>{text.title}</h1><p>{text.intro}</p></header>
    {sessionStatus === "loading" && <div className="product-load-state" role="status"><span>{text.loading}</span></div>}
    {sessionStatus === "error" && <div className="product-error" role="alert"><span>{locale === "zh-TW" ? "無法確認帳號狀態。" : "Could not verify your account."}</span><button type="button" onClick={() => void refreshSession()}>{text.retry}</button></div>}
    {sessionStatus === "ready" && !session?.authenticated && <section className="sign-in-empty"><UserRound aria-hidden="true" size={30} /><h2>{text.signIn}</h2><p>{text.signInDetail}</p><a className="primary-action" href="/api/auth/github?return=%2Fsettings%2Fprofile"><GitBranch aria-hidden="true" size={16} />{text.signIn}</a></section>}
    {sessionStatus === "ready" && session?.authenticated && <RemoteStateView state={profileState} loadingLabel={text.loading} retryLabel={text.retry} empty={null} isEmpty={() => false}>{(profile) => <>
      <form className="profile-form" onSubmit={(event) => void save(event, profile)}>
        <div className="profile-identity"><Image src={profile.avatarUrl} alt="" width={48} height={48} unoptimized /><div><strong>{profile.displayName}</strong><span>@{profile.login} · {profile.verifiedSolvedCount} {text.verified}</span></div></div>
        <label>{text.displayName}<input value={profile.displayName} maxLength={80} required onChange={(event) => updateProfile({ displayName: event.target.value })} /></label>
        <label>{text.bio}<textarea value={profile.bio} maxLength={2000} onChange={(event) => updateProfile({ bio: event.target.value })} /></label>
        <label>{text.website}<input type="url" inputMode="url" value={profile.websiteUrl ?? ""} onChange={(event) => updateProfile({ websiteUrl: event.target.value || null })} /></label>
        <label>{text.visibility}<select value={profile.visibility} onChange={(event) => updateProfile({ visibility: event.target.value as Profile["visibility"] })}><option value="public">{text.public}</option><option value="private">{text.private}</option></select></label>
        <div className="profile-form-actions"><button className="primary-action" disabled={saving}>{saving ? text.saving : text.save}</button>{profile.visibility === "public" && <Link className="secondary-action" href={`/profiles/${encodeURIComponent(profile.login)}`}><ExternalLink aria-hidden="true" size={15} />{text.publicProfile}</Link>}</div>
        {saveMessage && <output className={saveMessage === text.saved ? "" : "is-error"} role="status">{saveMessage}</output>}
      </form>
      <section className="account-danger-zone"><div><h2>{text.dangerTitle}</h2><p>{text.dangerDetail}</p></div><button ref={deleteButtonRef} className="danger-action" type="button" onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" size={15} />{text.delete}</button></section>
      <Drawer open={deleteOpen} label={text.confirmTitle} onClose={closeDelete} returnFocusRef={deleteButtonRef} initialFocusRef={deleteInputRef}>
        <div className="account-delete-drawer">
          <header><div><span className="product-eyebrow"><TriangleAlert aria-hidden="true" size={14} /> {text.dangerTitle}</span><h2>{text.confirmTitle}</h2></div><IconButton icon={X} label={text.close} onClick={closeDelete} /></header>
          <p>{text.confirmDetail}</p>
          <label>{text.typeLogin}<strong>{profile.login}</strong><input ref={deleteInputRef} autoComplete="off" spellCheck={false} value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /></label>
          {deleteError && <div className="product-error" role="alert"><span>{deleteError}</span></div>}
          <footer><button className="secondary-action" type="button" disabled={deleting} onClick={closeDelete}>{text.cancel}</button><button className="danger-action" type="button" disabled={deleting || deleteConfirmation !== profile.login} onClick={() => void deleteAccount(profile)}><Trash2 aria-hidden="true" size={15} />{deleting ? text.deleting : text.delete}</button></footer>
        </div>
      </Drawer>
    </>}</RemoteStateView>}
  </main>;
}
