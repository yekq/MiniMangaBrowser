import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Favorite, ItemTarget } from "../contracts";
import { useLocale } from "./settings";

function sameTarget(a: ItemTarget, b: ItemTarget) {
  return (
    a.kind === b.kind &&
    (a.kind === "source" && b.kind === "source"
      ? a.sourceId === b.sourceId
      : a.kind !== "source" &&
        b.kind !== "source" &&
        a.bookId === b.bookId &&
        (a.kind !== "page" || (b.kind === "page" && a.page === b.page)))
  );
}

export function ItemActions({
  target,
  title,
  onTrash,
  onError,
  label,
  flat = false,
  showTrash = false,
}: {
  target: ItemTarget;
  title: string;
  label?: string;
  flat?: boolean;
  showTrash?: boolean;
  onTrash: (target: ItemTarget) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [lang] = useLocale();
  const zh = lang === "zh";
  const client = useQueryClient();
  const { data: favorites = [] } = useQuery({
    queryKey: ["favorites"],
    queryFn: () => window.manga.favorites(),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const current = favorites.find((f) => sameTarget(f.target, target));
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
      await client.invalidateQueries({ queryKey: ["favorites"] });
    } catch (e) {
      onError(String(e));
    }
  };
  return (
    <div
      className="item-actions"
      aria-label={`${title} ${zh ? "操作" : "actions"}`}
    >
      <button
        className={current ? "favorite-active" : ""}
        title={
          current
            ? zh
              ? "取消收藏"
              : "Remove favorite"
            : zh
              ? "收藏（未评分）"
              : "Favorite (unrated)"
        }
        aria-label={`${label || title} ${current ? (zh ? "取消收藏" : "Remove favorite") : zh ? "收藏" : "Favorite"}`}
        onClick={() =>
          void run(() =>
            current
              ? window.manga.removeFavorite(current.id)
              : window.manga.setFavorite(target, 0),
          )
        }
      >
        {current ? "★" : "☆"} {label || (zh ? "收藏" : "Favorite")}
      </button>
      {flat ? (
        <div
          className="inline-stars"
          role="group"
          aria-label={`${title} ${zh ? "星级" : "stars"}`}
        >
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              aria-label={`${n}${zh ? "星" : " stars"}`}
              aria-pressed={current?.rating === n}
              title={`${n}${zh ? "星" : " stars"}`}
              onClick={() =>
                void run(() => window.manga.setFavorite(target, n))
              }
            >
              {n === 0 ? "0" : n <= (current?.rating || 0) ? "★" : "☆"}
            </button>
          ))}
        </div>
      ) : (
        <details className="rating-menu">
          <summary aria-label={`${title} ${zh ? "评分" : "rating"}`}>
            {current?.rating
              ? "★".repeat(current.rating)
              : zh
                ? "评分"
                : "Rate"}{" "}
            ▾
          </summary>
          <div
            className="rating-options"
            role="group"
            aria-label={`${title} ${zh ? "星级" : "stars"}`}
          >
            {[0, 1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                aria-pressed={current?.rating === rating}
                aria-label={`${rating}${zh ? "星" : " stars"}`}
                onClick={(event) => {
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                  void run(() => window.manga.setFavorite(target, rating));
                }}
              >
                {rating === 0
                  ? zh
                    ? "0星 · 未评分"
                    : "0 · Unrated"
                  : "★".repeat(rating)}
              </button>
            ))}
          </div>
        </details>
      )}
      {showTrash && (
        <button
          className="trash-action"
          aria-label={`${title} ${zh ? "删除到回收站" : "Move to Recycle Bin"}`}
          title={zh ? "删除到回收站" : "Move to Recycle Bin"}
          onClick={() => void onTrash(target)}
        >
          {zh ? "删除" : "Trash"}
        </button>
      )}
    </div>
  );
}

function FavoriteCard({
  favorite,
  onOpen,
  onTrash,
  onError,
}: {
  favorite: Favorite;
  onOpen: (id: string) => void;
  onTrash: (target: ItemTarget) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [lang] = useLocale();
  const zh = lang === "zh";
  const { data: cover } = useQuery({
    queryKey: ["favorite-cover", favorite.id],
    queryFn: () => window.manga.favoriteCover(favorite.id),
    retry: false,
  });
  return (
    <article className="book-card favorite-card">
      <button
        className="cover"
        data-comic-title={favorite.title}
        onClick={() => onOpen(favorite.id)}
      >
        <div className="art">
          {cover ? (
            <img loading="lazy" src={cover} alt={favorite.title} />
          ) : (
            <span>☆</span>
          )}
        </div>
        <strong className="comic-title-text">{favorite.title}</strong>
        <small>
          {favorite.kind === "page"
            ? zh
              ? "单页"
              : "Page"
            : favorite.kind === "source"
              ? zh
                ? "目录 / 快捷方式"
                : "Folder / shortcut"
              : zh
                ? "漫画"
                : "Book"}
          {favorite.rating
            ? " · " + "★".repeat(favorite.rating)
            : zh
              ? " · 未评分"
              : " · Unrated"}
          {!favorite.available && (zh ? " · 点击找回位置" : " · Click to find location")}
        </small>
      </button>
      <ItemActions
        target={favorite.target}
        title={favorite.title}
        onTrash={onTrash}
        onError={onError}
      />
    </article>
  );
}

export function FavoritesView({
  search,
  size,
  onOpen,
  onTrash,
  onError,
}: {
  search: string;
  size: number;
  onOpen: (id: string) => void;
  onTrash: (target: ItemTarget) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [lang] = useLocale();
  const zh = lang === "zh";
  const [rating, setRating] = React.useState(-1);
  const [kind, setKind] = React.useState("all");
  const [group, setGroup] = React.useState(0);
  React.useEffect(() => setGroup(0), [search, rating, kind, size]);
  const {
    data: favorites = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["favorites", search],
    queryFn: () => window.manga.favorites(search),
  });
  const filtered = favorites.filter(
    (f) =>
      (rating === -1 || f.rating === rating) &&
      (kind === "all" || f.kind === kind),
  );
  const total = Math.max(1, Math.ceil(filtered.length / size));
  React.useEffect(() => setGroup((g) => Math.min(g, total - 1)), [total]);
  return (
    <div className="favorites-workspace">
      <div className="favorites-filters">
        <span>
          {zh ? "我的收藏" : "Favorites"} · {filtered.length}
        </span>
        <select
          aria-label={zh ? "收藏类型" : "Favorite type"}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="all">{zh ? "全部类型" : "All types"}</option>
          <option value="book">{zh ? "漫画" : "Books"}</option>
          <option value="source">
            {zh ? "目录 / 快捷方式" : "Folders / shortcuts"}
          </option>
          <option value="page">{zh ? "单页" : "Pages"}</option>
        </select>
        <button
          disabled={group === 0}
          onClick={() => setGroup((g) => g - 1)}
          aria-label={zh ? "上一组收藏" : "Previous favorites"}
        >
          ‹
        </button>
        <span>
          {group + 1} / {total}
        </span>
        <button
          disabled={group >= total - 1}
          onClick={() => setGroup((g) => g + 1)}
          aria-label={zh ? "下一组收藏" : "Next favorites"}
        >
          ›
        </button>
        <select
          aria-label={zh ? "收藏评分" : "Favorite rating"}
          value={rating}
          onChange={(e) => setRating(Number(e.target.value))}
        >
          <option value={-1}>{zh ? "全部评分" : "All ratings"}</option>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? (zh ? "0星 · 未评分" : "0 · Unrated") : "★".repeat(n)}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{String(error)}</p>}
      {isLoading ? (
        <p>{zh ? "正在读取收藏…" : "Loading favorites…"}</p>
      ) : filtered.length ? (
        <div className={"grid g" + size}>
          {filtered.slice(group * size, (group + 1) * size).map((f) => (
            <FavoriteCard
              key={f.id}
              favorite={f}
              onOpen={onOpen}
              onTrash={onTrash}
              onError={onError}
            />
          ))}
        </div>
      ) : (
        <div className="favorites-empty">
          <span>☆</span>
          <h2>
            {zh ? "把喜欢的故事留在这里" : "Keep your favorite stories here"}
          </h2>
          <p>
            {zh
              ? "收藏漫画、目录、快捷方式或单页；也可以直接用星级评分收藏。"
              : "Favorite books, folders, shortcuts or individual pages. Choose a star rating to save a favorite."}
          </p>
        </div>
      )}
    </div>
  );
}
