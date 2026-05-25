import { useState } from "react";
import { Link } from "wouter";
import {
  useListVendors,
  useCreateVendor,
  useUpdateVendor,
  useDeleteVendor,
  getListVendorsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Copy, Check, ExternalLink } from "lucide-react";
import { format } from "date-fns";

interface VendorForm {
  name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  type: string;
  status: string;
  notes: string;
}

const emptyForm: VendorForm = {
  name: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
  type: "lead_gen",
  status: "active",
  notes: "",
};

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 gap-1 text-xs text-muted-foreground"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function buildPortalUrl(token: string | null | undefined): string | null {
  if (!token) return null;
  const base = window.location.origin;
  return `${base}/vp/${token}`;
}

export default function Vendors() {
  const { data: vendors, isLoading } = useListVendors({
    query: { queryKey: getListVendorsQueryKey() },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [form, setForm] = useState<VendorForm>(emptyForm);

  const createMutation = useCreateVendor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
        setDialogOpen(false);
        setForm(emptyForm);
        toast({ title: "Vendor created" });
      },
    },
  });

  const updateMutation = useUpdateVendor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
        setDialogOpen(false);
        setEditingId(null);
        setForm(emptyForm);
        toast({ title: "Vendor updated" });
      },
    },
  });

  const deleteMutation = useDeleteVendor({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
        setDeleteDialogOpen(false);
        setDeletingId(null);
        toast({ title: "Vendor deleted" });
      },
    },
  });

  const handleSubmit = () => {
    if (!form.name.trim()) return;
    const body = {
      name: form.name,
      contact_name: form.contact_name || undefined,
      contact_email: form.contact_email || undefined,
      contact_phone: form.contact_phone || undefined,
      type: form.type,
      status: form.status,
      notes: form.notes || undefined,
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: body });
    } else {
      createMutation.mutate({ data: body });
    }
  };

  const openEdit = (vendor: any) => {
    setEditingId(vendor.id);
    setForm({
      name: vendor.name,
      contact_name: vendor.contact_name || "",
      contact_email: vendor.contact_email || "",
      contact_phone: vendor.contact_phone || "",
      type: vendor.type || "lead_gen",
      status: vendor.status || "active",
      notes: vendor.notes || "",
    });
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Vendors</h1>
        <Button onClick={openCreate} className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Add Vendor
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Portal Link</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-14" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-20 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : vendors?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center">
                  No vendors yet.
                </TableCell>
              </TableRow>
            ) : (
              vendors?.map((vendor: any) => {
                const portalUrl = buildPortalUrl(vendor.portal_token);
                return (
                  <TableRow key={vendor.id}>
                    <TableCell>
                      <span className="font-mono text-xs font-semibold text-muted-foreground">
                        {vendor.internal_code ?? `V-${vendor.id}`}
                      </span>
                    </TableCell>
                    <TableCell className="font-medium">{vendor.name}</TableCell>
                    <TableCell>
                      <div className="text-sm">{vendor.contact_name || "-"}</div>
                      <div className="text-xs text-muted-foreground">{vendor.contact_email || ""}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{vendor.type}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={vendor.status === "active" ? "default" : "secondary"}>
                        {vendor.status.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {portalUrl ? (
                        <div className="flex items-center gap-1">
                          <CopyButton text={portalUrl} label="Copy" />
                          <Link href={`/vp/${vendor.portal_token}`} target="_blank">
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground">
                              <ExternalLink className="h-3 w-3" />
                            </Button>
                          </Link>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm font-mono">
                      {format(new Date(vendor.created_at), "yyyy-MM-dd")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(vendor)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setDeletingId(vendor.id); setDeleteDialogOpen(true); }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Vendor" : "Add Vendor"}</DialogTitle>
            <DialogDescription>
              {editingId ? "Update vendor details." : "Create a new vendor. A portal link and partner code will be auto-assigned."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="contact_name">Contact Name</Label>
                <Input id="contact_name" value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="contact_email">Contact Email</Label>
                <Input id="contact_email" type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="contact_phone">Contact Phone</Label>
                <Input id="contact_phone" value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="type">Type</Label>
                <Select value={form.type} onValueChange={(val) => setForm({ ...form, type: val })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lead_gen">Lead Gen</SelectItem>
                    <SelectItem value="law_firm">Law Firm</SelectItem>
                    <SelectItem value="marketing">Marketing</SelectItem>
                    <SelectItem value="referral">Referral</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="status">Status</Label>
              <Select value={form.status} onValueChange={(val) => setForm({ ...form, status: val })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Input id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={!form.name.trim()}>
              {editingId ? "Save Changes" : "Create Vendor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Vendor</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this vendor? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deletingId && deleteMutation.mutate({ id: deletingId })}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
