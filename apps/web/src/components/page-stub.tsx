import { Badge } from "@/components/ui/badge";

export function PageStub({
  title,
  phase,
  description,
}: {
  title: string;
  phase: string;
  description: string;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        <Badge variant="secondary">arrives in {phase}</Badge>
      </div>
      <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
