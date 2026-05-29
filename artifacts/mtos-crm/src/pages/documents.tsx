import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListDocuments, getListDocumentsQueryKey, useDeleteDocument } from "@workspace/api-client-react";
import type { Document } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { FileText, Eye, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const ROLES_CAN_DELETE = new Set(["super_admin", "admin", "attorney"]);

export default function Documents() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canDelete = !!user && ROLES_CAN_DELETE.has(user.role);

  const [pendingDelete, setPendingDelete] = useState<Document | null>(null);

  const { data: documents, isLoading } = useListDocuments({}, {
    query: { queryKey: getListDocumentsQueryKey({}) }
  });

  const deleteDocument = useDeleteDocument({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey({}) });
        toast({ title: "Document deleted" });
        setPendingDelete(null);
      },
      onError: () => {
        toast({ title: "Delete failed", description: "You may not have permission to delete this document.", variant: "destructive" });
      },
    },
  });

  const viewHref = (id: number, download = false) =>
    `${import.meta.env.BASE_URL}api/documents/${id}/view${download ? "?download=1" : ""}`.replace(/([^:]\/)\/+/g, "$1");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Document Center</h1>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Lead ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : documents?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center">
                  No documents found.
                </TableCell>
              </TableRow>
            ) : (
              documents?.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    {doc.file_name}
                  </TableCell>
                  <TableCell className="capitalize">{doc.document_type.replace('_', ' ')}</TableCell>
                  <TableCell>
                    <Link href={`/leads/${doc.lead_id}`} className="hover:underline font-mono">
                      #{doc.lead_id}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {doc.signed ? (
                      <Badge variant="secondary" className="bg-green-500/20 text-green-500">Signed</Badge>
                    ) : (
                      <Badge variant="outline">Pending</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm font-mono">
                    {format(new Date(doc.created_at), "yyyy-MM-dd")}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" asChild data-testid={`button-view-document-${doc.id}`}>
                        <a
                          href={viewHref(doc.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View document"
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          View
                        </a>
                      </Button>
                      <Button variant="ghost" size="sm" asChild data-testid={`button-download-document-${doc.id}`}>
                        <a
                          href={viewHref(doc.id, true)}
                          download={doc.file_name}
                          title="Download document"
                        >
                          <Download className="h-4 w-4 mr-1" />
                          Download
                        </a>
                      </Button>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setPendingDelete(doc)}
                          title="Delete document"
                          data-testid={`button-delete-document-${doc.id}`}
                        >
                          <Trash2 className="h-4 w-4 mr-1" />
                          Delete
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? (
                <>This will permanently remove <span className="font-medium">{pendingDelete.file_name}</span> (lead #{pendingDelete.lead_id}). This action cannot be undone.</>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDocument.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteDocument.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (pendingDelete) deleteDocument.mutate({ id: pendingDelete.id });
              }}
            >
              {deleteDocument.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
