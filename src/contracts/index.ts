export interface Book {
  id: string;
  path: string;
  title: string;
  pages: number;
  progress: number;
  tags: string;
  author: string;
  onlineUrl?: string;
}
export interface OnlineSource { url: string; title: string; builtIn?: boolean }
export interface OnlineEntry { url: string; title: string; cover?: string }
export interface OnlineListing { url: string; items: OnlineEntry[]; next?: string; previous?: string }
export interface OnlineTask {
  id: string;
  title: string;
  total: number;
  done: number;
  state: "running" | "done" | "failed" | "cancelled";
  retryAt?: number;
  book?: Book;
  error?: string;
}
export interface Page {
  id: string;
  title: string;
  url: string;
}
export interface TreeNode {
  id: string;
  title: string;
  leaf: boolean;
  bookId?: string;
}
export interface ReadingChoice {
  id: string;
  title: string;
  kind: "folder" | "file";
}
export interface ReadingChoices {
  items: ReadingChoice[];
  nextId?: string;
}
export type ItemTarget =
  | { kind: "book"; bookId: string }
  | { kind: "page"; bookId: string; page: number }
  | { kind: "source"; sourceId: string };
export interface Favorite {
  id: string;
  kind: ItemTarget["kind"];
  title: string;
  rating: number;
  target: ItemTarget;
  available: boolean;
  bookId?: string;
  page?: number;
  sourceId?: string;
}
export interface FavoriteLocation {
  book?: Book;
  page?: number;
  sourceId?: string;
  bookIds?: string[];
  title?: string;
}
export interface Api {
  onlineSources(): Promise<OnlineSource[]>;
  onlineSaveSource(url: string, title: string): Promise<string>;
  onlineRemoveSource(url: string): Promise<void>;
  onlineList(url: string, keyword: string): Promise<OnlineListing>;
  onlineOpen(url: string): Promise<Book>;
  onlinePages(id: string): Promise<Page[]>;
  onlineProgress(id: string, page: number): Promise<void>;
  onlineCache(id: string): Promise<void>;
  onlineTasks(): Promise<OnlineTask[]>;
  onlineCancel(id: string): Promise<void>;
  onlineExternal(url: string): Promise<void>;
  repairInfo(target: RepairTarget): Promise<RepairInfo>;
  repairSearch(target: RepairTarget, keyword: string): Promise<RepairSearch>;
  repairBrowse(target: RepairTarget, mode: "folder" | "file"): Promise<RepairCandidate | null>;
  repairApply(target: RepairTarget, candidateId: string): Promise<RepairResult>;
  aiProfiles(): Promise<{ profiles: AiProfile[]; defaultProfile: string }>;
  aiConfigure(): Promise<void>;
  aiStart(bookId: string, page: number, prompt: string, profileId: string, options?: AiEditOptions): Promise<AiEdit>;
  aiHistory(query?: string, bookId?: string): Promise<AiEdit[]>;
  aiGet(id: string): Promise<AiEdit>;
  aiOriginal(id: string): Promise<string | null>;
  aiSave(id: string): Promise<AiEdit>;
  aiDelete(id: string): Promise<void>;
  aiRemove(id: string): Promise<void>;
  locateBook(bookId: string): Promise<string[]>;
  readingChoices(bookId: string): Promise<ReadingChoices>;
  readingChoiceCover(id: string): Promise<string>;
  openSource(id: string): Promise<Book | null>;
  forgetSource(id: string): Promise<void>;
  cover(id: string): Promise<string>;
  sources(): Promise<TreeNode[]>;
  children(id: string): Promise<TreeNode[]>;
  list(): Promise<Book[]>;
  import(mode?: "folder" | "files"): Promise<Book[]>;
  open(id: string): Promise<Page[]>;
  reveal(id: string, page: number): Promise<void>;
  progress(id: string, page: number): Promise<void>;
  metadata(id: string, tags: string, author: string): Promise<void>;
  thumb(url: string): Promise<string>;
  favorites(query?: string): Promise<Favorite[]>;
  setFavorite(target: ItemTarget, rating: number): Promise<void>;
  removeFavorite(id: string): Promise<void>;
  openFavorite(id: string): Promise<FavoriteLocation>;
  favoriteCover(id: string): Promise<string>;
  searchHistory(): Promise<string[]>;
  rememberSearch(query: string): Promise<void>;
  clearSearchHistory(): Promise<void>;
  trash(target: ItemTarget): Promise<boolean>;
}
export type RepairTarget = { kind: "book" | "source" | "favorite" | "ai"; id: string };
export interface RepairInfo { title: string; oldPath: string; keyword: string; available: boolean; bookId?: string; page?: number; missingRecord: boolean }
export interface RepairCandidate { id: string; title: string; path: string; kind: "folder" | "file"; size?: number }
export interface RepairSearch { items: RepairCandidate[]; total: number }
export interface RepairResult { book?: Book; sourceId?: string; favoriteId?: string; page?: number }
export interface AiParameter { key: string; label: string; min: number; max: number; step: number; default: number }
export interface AiProfile { id: string; name: string; provider: string; endpoint: string; requiresMask?: boolean; promptHint?: string; parameters?: AiParameter[] }
export interface AiEditOptions { mask?: string; parameters?: Record<string, number> }
export interface AiEdit {
  id: string; bookId: string; bookTitle: string; pageTitle: string; page: number;
  prompt: string; profileId: string; profileName: string; createdAt: number;
  status: "generating" | "ready" | "saved" | "failed" | "deleted";
  imageUrl?: string; savedPath?: string; error?: string; seconds?: number;
  localEdit?: boolean; parameters?: Record<string, number>;
}
declare global {
  interface Window {
    manga: Api;
  }
}
