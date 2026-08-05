import { createFileRoute } from "@tanstack/react-router";
import { allProducts } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

export const Route = createFileRoute("/products/")({
  component: ProductsPage,
});

function ProductsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Products
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          JSON collection with <code>localized: false</code>, unique SKU, and
          optional brochure via <code>a.file()</code>.
        </p>
        <FeatureBadges
          items={["json loader", "localized: false", "s.unique()", "a.file()"]}
        />
      </div>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Brochure</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allProducts.map((product) => (
              <TableRow key={product._meta.id}>
                <TableCell className="font-medium">{product.name}</TableCell>
                <TableCell>
                  <Badge variant="outline">{product.sku}</Badge>
                </TableCell>
                <TableCell>${product.price}</TableCell>
                <TableCell>
                  {product.brochure ? (
                    <a
                      href={product.brochure.src}
                      className="underline underline-offset-4"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
