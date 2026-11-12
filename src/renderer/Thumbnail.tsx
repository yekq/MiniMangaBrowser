import React from "react";
import { useQuery } from "@tanstack/react-query";
export function Thumbnail({ url, title, compact = false }: { url: string; title: string; compact?: boolean }) {
  const { data } = useQuery({
    queryKey: ["thumbnail", url],
    queryFn: () => window.manga.thumb(url),
    staleTime: 300000,
    refetchOnWindowFocus: false,
    retry: compact ? false : 1,
  });
  return data ? (
    <img src={data} alt={title} loading="lazy" decoding="async" draggable={false} />
  ) : (
    <span
      style={{
        height: compact ? 58 : 210,
        display: "grid",
        placeItems: "center",
        color: "#7e8e76",
      }}
    >
      ▥
    </span>
  );
}
