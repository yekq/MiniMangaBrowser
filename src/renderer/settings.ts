import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SearchScheme } from "../contracts/titleSearch";
type Settings = {
  language: "zh" | "en";
  setLanguage: (language: "zh" | "en") => void;
  filmstripVisible: boolean;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  setFilmstripVisible: (visible: boolean) => void;
  searchSchemes: SearchScheme[];
  defaultSearchScheme: string;
  saveSearchScheme: (scheme: SearchScheme) => void;
  removeSearchScheme: (id: string) => void;
  setDefaultSearchScheme: (id: string) => void;
};
export const useSettings = create<Settings>()(
  persist(
    (set) => ({ language: "zh", setLanguage: (language) => set({ language }),
      sidebarWidth: 280, setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      filmstripVisible: true, setFilmstripVisible: (filmstripVisible) => set({ filmstripVisible }),
      searchSchemes: [],
      defaultSearchScheme: "e-hentai",
      saveSearchScheme: (scheme) => set(state => ({
        searchSchemes: state.searchSchemes.some(item => item.id === scheme.id)
          ? state.searchSchemes.map(item => item.id === scheme.id ? scheme : item)
          : [...state.searchSchemes, scheme],
      })),
      removeSearchScheme: (id) => set(state => ({
        searchSchemes: state.searchSchemes.filter(item => item.id !== id),
        defaultSearchScheme: state.defaultSearchScheme === id ? "e-hentai" : state.defaultSearchScheme,
      })),
      setDefaultSearchScheme: (defaultSearchScheme) => set({ defaultSearchScheme }),
    }),
    { name: "mini.manga.settings" },
  ),
);
export function useLocale() {
  return [
    useSettings((s) => s.language),
    useSettings((s) => s.setLanguage),
  ] as const;
}
