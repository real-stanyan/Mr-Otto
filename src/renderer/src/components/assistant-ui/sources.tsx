"use client";

import { memo, useState, type ComponentProps } from "react";
import { FileTextIcon } from "lucide-react";
import type { VariantProps } from "class-variance-authority";
import type { SourceMessagePartComponent } from "@assistant-ui/react";
import { cn } from "@/lib/utils.js";
import { Badge, badgeVariants } from "./badge.js";

const extractDomain = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// 本仓改动(registry 升级时人工合的依据):上游默认去 DuckDuckGo 取 favicon
// (`https://icons.duckduckgo.com/ip3/${domain}.ico`)。两条理由各自都够:
// (1) renderer 的 CSP(src/renderer/index.html)img-src 白名单里没有这个域,
//     请求必然被拦,只换来一屏 CSP 报错;
// (2) 每渲染一条来源就等于把用户查过的域名报给第三方。
// 改成不取图标 —— 直接走上游自带的首字母兜底(它本来就存在,用来兜 favicon 404),
// 这里只是让它成为唯一路径。要恢复图标:把域名加进 index.html 的 img-src,
// 再从外面把 faviconUrl 传回来
const defaultFaviconUrl = (_domain: string): string | undefined => undefined;

function SourceIcon({
  url,
  className,
  faviconUrl = defaultFaviconUrl,
  ...props
}: ComponentProps<"span"> & {
  url: string;
  // 本仓改动:返回类型放宽到可空,undefined = 这一条不取图标(见 defaultFaviconUrl)
  faviconUrl?: (domain: string) => string | undefined;
}) {
  const domain = extractDomain(url);
  const src = faviconUrl(domain);
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined);
  // 本仓改动:src 为 undefined 时也走兜底那条路径
  const hasError = src === undefined || errorSrc === src;

  if (hasError) {
    return (
      <span
        data-slot="source-icon-fallback"
        className={cn(
          "bg-muted flex size-3 shrink-0 items-center justify-center rounded-sm text-[10px] font-medium",
          className,
        )}
        {...props}
      >
        {domain.charAt(0).toUpperCase() || "?"}
      </span>
    );
  }

  return (
    <img
      data-slot="source-icon"
      src={src}
      alt=""
      className={cn("size-3 shrink-0 rounded-sm", className)}
      onError={() => setErrorSrc(src)}
      {...(props as ComponentProps<"img">)}
    />
  );
}

function SourceTitle({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="source-title"
      className={cn("max-w-37.5 truncate", className)}
      {...props}
    />
  );
}

function DocumentSourceIcon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="source-document-icon"
      className={cn(
        "text-muted-foreground flex size-3 shrink-0 items-center justify-center",
        className,
      )}
      {...props}
    >
      <FileTextIcon className="size-3" />
    </span>
  );
}

export type SourceProps = ComponentProps<"a"> &
  VariantProps<typeof badgeVariants>;

function Source({
  className,
  variant,
  size,
  target = "_blank",
  rel = "noopener noreferrer",
  ...props
}: SourceProps) {
  return (
    <a
      data-slot="source"
      className={cn(
        badgeVariants({ variant, size }),
        "focus-visible:border-ring focus-visible:ring-ring/50 cursor-pointer outline-none focus-visible:ring-1",
        className,
      )}
      target={target}
      rel={rel}
      {...props}
    />
  );
}

const SourcesImpl: SourceMessagePartComponent = (part) => {
  if (part.sourceType === "url" && part.url) {
    const domain = extractDomain(part.url);
    const displayTitle = part.title || domain;

    return (
      <Source href={part.url}>
        <SourceIcon url={part.url} />
        <SourceTitle>{displayTitle}</SourceTitle>
      </Source>
    );
  }

  if (part.sourceType === "document") {
    return (
      <Badge
        variant="secondary"
        className="focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-1"
      >
        <span data-slot="source" className="inline-flex items-center gap-1.5">
          <DocumentSourceIcon />
          <SourceTitle>{part.title}</SourceTitle>
        </span>
      </Badge>
    );
  }

  return null;
};

const Sources = memo(SourcesImpl) as unknown as SourceMessagePartComponent & {
  Root: typeof Source;
  Icon: typeof SourceIcon;
  Title: typeof SourceTitle;
};

Sources.displayName = "Sources";
Sources.Root = Source;
Sources.Icon = SourceIcon;
Sources.Title = SourceTitle;

export {
  Sources,
  Source,
  SourceIcon,
  SourceTitle,
  badgeVariants as sourceVariants,
};
