"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";

type Organization = {
  id: string;
  name: string;
  role: "owner" | "admin" | "developer" | "viewer";
  member_count: number;
  project_count: number;
};

type Member = {
  id: string;
  email: string;
  role: "owner" | "admin" | "developer" | "viewer";
  disabled: boolean;
};

export default function TeamPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "developer" | "viewer">("developer");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const organization = useMemo(
    () => organizations.find((item) => item.id === organizationId),
    [organizations, organizationId],
  );

  const loadMembers = useCallback(async (id: string) => {
    if (!id) return;
    setError("");
    try {
      const result = await api(`/v1/organizations/${id}/members`);
      setMembers(result.items || []);
    } catch (e) {
      setMembers([]);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api("/v1/organizations");
        const items = (result.items || []) as Organization[];
        setOrganizations(items);
        const manageable = items.find((item) => ["owner", "admin"].includes(item.role));
        if (manageable) {
          setOrganizationId(manageable.id);
          await loadMembers(manageable.id);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadMembers]);

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    setBusy("add");
    setError("");
    try {
      await api(`/v1/organizations/${organizationId}/members`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      setEmail("");
      setRole("developer");
      await loadMembers(organizationId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const changeRole = async (member: Member, nextRole: "admin" | "developer" | "viewer") => {
    setBusy(member.id);
    setError("");
    try {
      await api(`/v1/organizations/${organizationId}/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
      await loadMembers(organizationId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const removeMember = async (member: Member) => {
    setBusy(member.id);
    setError("");
    try {
      await api(`/v1/organizations/${organizationId}/members/${member.id}`, {
        method: "DELETE",
      });
      await loadMembers(organizationId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const manageableOrganizations = organizations.filter((item) =>
    ["owner", "admin"].includes(item.role),
  );

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Team administration</h1>
          <p>Manage organization membership with protected owner and admin boundaries.</p>
        </div>
        {manageableOrganizations.length > 0 && (
          <select
            value={organizationId}
            onChange={(event) => {
              setOrganizationId(event.target.value);
              void loadMembers(event.target.value);
            }}
          >
            {manageableOrganizations.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name} · {item.role}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {!loading && manageableOrganizations.length === 0 ? (
        <section className="panel">
          <p className="muted">You do not administer any organizations.</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-head">
              <span>ADD EXISTING USER</span>
              <span>
                {organization?.member_count ?? members.length} members · {organization?.project_count ?? 0} projects
              </span>
            </div>
            <form className="form-row" onSubmit={addMember}>
              <input
                type="email"
                required
                maxLength={254}
                placeholder="teammate@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <select
                value={role}
                onChange={(event) =>
                  setRole(event.target.value as "admin" | "developer" | "viewer")
                }
              >
                {organization?.role === "owner" && <option value="admin">Admin</option>}
                <option value="developer">Developer</option>
                <option value="viewer">Viewer</option>
              </select>
              <button className="button" disabled={busy === "add" || !organizationId}>
                Add member
              </button>
            </form>
            <p className="muted code">
              The account must already exist. Only owners can grant the admin role.
            </p>
          </section>

          <section className="panel">
            <div className="panel-head">
              <span>MEMBERS</span>
              <span>{members.length} visible</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Account</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => {
                    const protectedRole = member.role === "owner";
                    const adminProtected =
                      member.role === "admin" && organization?.role !== "owner";
                    const canEdit = !protectedRole && !adminProtected;
                    return (
                      <tr key={member.id}>
                        <td className="mono">{member.email}</td>
                        <td>
                          {canEdit ? (
                            <select
                              value={member.role}
                              disabled={busy === member.id}
                              onChange={(event) =>
                                void changeRole(
                                  member,
                                  event.target.value as "admin" | "developer" | "viewer",
                                )
                              }
                            >
                              {organization?.role === "owner" && <option value="admin">Admin</option>}
                              <option value="developer">Developer</option>
                              <option value="viewer">Viewer</option>
                            </select>
                          ) : (
                            <span className="state completed">{member.role}</span>
                          )}
                        </td>
                        <td>{member.disabled ? "Disabled" : "Active"}</td>
                        <td>
                          <button
                            className="button small danger"
                            disabled={!canEdit || busy === member.id}
                            onClick={() => void removeMember(member)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
