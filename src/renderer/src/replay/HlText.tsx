import { hl } from "./hl.js";

/** token 数组 → 着色 span。token 类的配色作用域挂在容器的 .hl 上（app.css） */
export function Hl({ src }: { src: string }) {
  return (
    <>
      {hl(src).map((t, i) =>
        t.cls ? (
          <i key={i} className={t.cls}>
            {t.text}
          </i>
        ) : (
          t.text
        )
      )}
    </>
  );
}
