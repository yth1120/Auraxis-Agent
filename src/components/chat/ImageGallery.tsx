import { memo, useMemo } from 'react';
import { Image } from 'antd';

/** Extract image URLs from message content: raw data-URL blocks + markdown images. */
export function extractImageUrls(content: string): string[] {
  if (!content) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (u: string) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  const dataRe = /data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g;
  let m: RegExpExecArray | null;
  while ((m = dataRe.exec(content))) add(m[0]);
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  while ((m = mdRe.exec(content))) add(m[1]);
  return urls;
}

/** Remove `【图片: name】\ndata:...` blocks so the raw text stays clean. */
export function stripImageBlocks(content: string): string {
  return content.replace(/【图片: [^\n】]*】\s*\n?data:image\/[^\s]+/g, '').replace(/^\n+/, '');
}

interface ImageGalleryProps {
  content: string;
  /** Only render raw data-URL images (markdown images render inline already). */
  onlyDataUrls?: boolean;
}

export default memo(function ImageGallery({ content, onlyDataUrls }: ImageGalleryProps) {
  const urls = useMemo(() => {
    const all = extractImageUrls(content);
    return onlyDataUrls ? all.filter((u) => u.startsWith('data:image/')) : all;
  }, [content, onlyDataUrls]);

  if (urls.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 my-2">
      <Image.PreviewGroup>
        {urls.map((src, i) => (
          <Image
            key={i}
            src={src}
            width={128}
            height={128}
            className="rounded-lg object-cover cursor-zoom-in"
            style={{ objectFit: 'cover', borderRadius: 8 }}
          />
        ))}
      </Image.PreviewGroup>
    </div>
  );
});
