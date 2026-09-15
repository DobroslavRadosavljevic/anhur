import type { ImgHTMLAttributes } from "react";

import { cn } from "~/lib/utils";

function Img({
  className,
  alt = "",
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  return <img alt={alt} className={cn(className)} {...props} />;
}

export { Img };
