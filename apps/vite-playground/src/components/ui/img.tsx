import type { ImgHTMLAttributes } from "react";

import { cn } from "~/lib/class-names";

function Img({
  className,
  alt = "",
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  return <img alt={alt} className={cn(className)} {...props} />;
}

export { Img };
