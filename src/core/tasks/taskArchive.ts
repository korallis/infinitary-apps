import { sessionFilesIn } from "../storage/sessionReader";
import type { TaskEvent } from "../storage/taskEventStore";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskReference, TaskReferenceKind } from "../storage/taskReferenceStore";
import { conversationOf, type TaskSession } from "../storage/taskSessionStore";
import type { TaskExportBundle } from "./taskExport";
import type { TaskService } from "./taskService";
import { splitReferences } from "./taskService";
import type { TaskWriter } from "./taskWriter";

/**
 * What the record keeps of conversations and specifications, the import that
 * restores records, and the hard deletes: a spawn that never ran, a withdrawn
 * operation and the D-13 purge. Reached as `tasks.archive`.
 */
export class TaskArchive {
  constructor(
    private readonly writer: TaskWriter,
    private readonly tasks: TaskService,
  ) {}

  /** Durable rows only, for record export without inferred folder metadata. */
  specificationFor(event: TaskEvent) {
    const revision = event.data?.specificationRevision;
    return typeof revision === "number" && this.writer.store.specifications.exists()
      ? this.writer.store.specifications.at(event.taskId, revision)
      : undefined;
  }

  recordedSpecifications(id: string) {
    return this.writer.store.specifications.exists()
      ? this.writer.store.specifications.history(id)
      : [];
  }

  sessionObservations(id: string) {
    return this.writer.conversations.observations(id);
  }

  sessionObservation(id: string) {
    return this.writer.conversations.observation(id);
  }

  recordedSessions(id: string): TaskSession[] {
    return this.writer.conversations.list(id);
  }

  /**
   * The recorded conversation a task's resume binding names, for record
   * export (INF-1296 piece 3); null when its token names none.
   */
  recordedConversation(id: string): string | null {
    return this.writer.store.execution.get(id).conversation;
  }

  /** A task's basis, branch source and earlier attempt as recorded, for record export. */
  recordedReferences(id: string): TaskReference[] {
    return this.writer.references.list(id);
  }

  /**
   * Recorded conversations plus unlabelled files retained before the
   * association existed. `folder` is this computer's folder of the task's
   * conversation files, and `device` the id its own conversations are
   * recorded under.
   */
  sessions(id: string, folder?: { dir: string; computer: string; device?: string }) {
    const task = this.writer.mustGet(id);
    // The resume binding names the conversation it resumes (INF-1296 piece
    // 3); a token from before associations names the one its file is.
    const binding = this.writer.store.execution.get(id);
    const resumes =
      binding.conversation ?? (task.sessionFile ? conversationOf(task.sessionFile) : null);
    const kept = new Map(
      (folder ? sessionFilesIn(folder.dir) : []).map(
        (file) => [conversationOf(file), file] as const,
      ),
    );
    // A row is matched by the conversation id it was recorded under, never by
    // reading its saved location again: a home that moved here from a
    // computer of another system brings locations this computer's folder
    // rules do not read, and the file itself came over into this folder
    // (docs/devices.md, "A home on another system").
    const rows: (Omit<TaskSession, "began" | "opened_at" | "last_at" | "resume_token"> & {
      began: string | null;
      opened_at: number | null;
      last_at: number | null;
      current: boolean;
    })[] = this.writer.conversations.list(id).map(({ resume_token: _token, ...session }) => ({
      ...session,
      file:
        (session.device_id === folder?.device && kept.get(session.conversation)) || session.file,
      current: resumes === session.conversation,
    }));
    const known = new Set(rows.map((row) => row.conversation));
    for (const [conversation, file] of kept) {
      if (known.has(conversation)) continue;
      rows.push({
        conversation,
        file,
        computer: folder?.computer ?? null,
        device_id: null,
        provider: null,
        model: null,
        account_id: null,
        opened_at: null,
        last_at: null,
        began: null,
        current: resumes === conversation,
      });
    }
    return rows;
  }

  /** A spawn that failed before its crewmate ever ran leaves nothing behind. */
  discardFailedSpawn(id: string): void {
    this.erase(id);
  }

  /** A settled run that came back where it started leaves no operation. */
  withdrawOperation(id: string): void {
    const record = this.writer.mustGet(id);
    if (record.kind !== "operation") throw new Error(`${record.key} is not an operation.`);
    this.erase(id);
  }

  private erase(id: string): void {
    const run = this.writer.write(() => {
      this.writer.events.deleteFor(id);
      this.writer.links.deleteFor(id);
      this.writer.conversations.deleteFor(id);
      this.writer.references.deleteFor(id);
      this.writer.store.delete(id);
      this.writer.pending.removed.add(id);
    });
    run();
  }

  /** The D-13 purge: every task, event, link and ask; projects stay. */
  purge(): number {
    const run = this.writer.write(() => {
      this.writer.events.deleteAll();
      this.writer.links.deleteAll();
      this.writer.asks.deleteAll();
      this.writer.conversations.deleteAll();
      this.writer.references.deleteAll();
      this.writer.pending.reset = true;
      return this.writer.store.deleteAll();
    });
    return run();
  }

  /**
   * Reload an export (P5, `src/core/tasks/taskExport.ts`): every row
   * verbatim, in one transaction, through the one writer. Refused before
   * anything is written when a task id or key is already taken, when a
   * project key belongs to another id, or when a row references a task
   * that is neither in the bundle nor here. A project already present keeps
   * its row and only its sequence rises; a missing one is inserted as
   * exported. The board resets, so clients take a fresh snapshot.
   */
  importRecords(bundle: TaskExportBundle): {
    projects: number;
    tasks: number;
    events: number;
    links: number;
    asks: number;
  } {
    const run = this.writer.write(() => {
      const known = new Set(this.writer.store.list().map((record) => record.id));
      const incoming = new Set(bundle.tasks.map((record) => record.id));
      const refuse = (why: string): never => {
        throw new Error(`Import refused: ${why}`);
      };
      const resolves = (id: string | null): boolean =>
        id === null || incoming.has(id) || known.has(id);
      for (const project of bundle.projects) {
        const byId = this.writer.projects.get(project.id);
        const byKey = this.writer.projects.byKey(project.key);
        if (byKey && byKey.id !== project.id) {
          refuse(`project key ${project.key} belongs to "${byKey.id}", not "${project.id}".`);
        }
        if (byId && byId.key !== project.key) {
          refuse(`project "${project.id}" is keyed ${byId.key} here, not ${project.key}.`);
        }
      }
      const projectIds = new Set([
        ...bundle.projects.map((project) => project.id),
        ...this.writer.projects.list().map((project) => project.id),
      ]);
      for (const record of bundle.tasks) {
        if (known.has(record.id)) refuse(`task "${record.id}" already exists.`);
        if (this.writer.store.byKey(record.key)) refuse(`task key ${record.key} is already taken.`);
        if (!projectIds.has(record.projectId)) {
          refuse(`task ${record.key} names an unknown project "${record.projectId}".`);
        }
        if (!resolves(record.parentId)) {
          refuse(`task ${record.key} names an unknown parent "${record.parentId}".`);
        }
      }
      for (const event of bundle.events) {
        if (!resolves(event.taskId)) refuse(`an event names an unknown task "${event.taskId}".`);
        for (const concern of event.concerns ?? []) {
          if (!resolves(concern.taskId)) {
            refuse(`an event concerns an unknown task "${concern.taskId}".`);
          }
        }
      }
      for (const link of bundle.links) {
        if (!resolves(link.fromId) || !resolves(link.toId)) {
          refuse(`a link names an unknown task ("${link.fromId}" -> "${link.toId}").`);
        }
      }
      for (const ask of bundle.asks) {
        if (this.writer.asks.get(ask.id)) refuse(`ask "${ask.id}" already exists.`);
        if (!resolves(ask.taskId)) refuse(`ask "${ask.id}" names an unknown task "${ask.taskId}".`);
      }
      let projects = 0;
      for (const project of bundle.projects) {
        if (this.writer.projects.get(project.id)) {
          this.writer.projects.adopt(project);
        } else {
          this.writer.projects.insert(project);
          projects += 1;
        }
      }
      const recorded = new Map<string, TaskReference[]>();
      for (const { taskId, reference } of bundle.references ?? []) {
        if (!incoming.has(taskId))
          throw new Error(`A relationship names an unknown task: ${taskId}`);
        recorded.set(taskId, [...(recorded.get(taskId) ?? []), reference]);
      }
      const named: [TaskRecord, TaskReferenceKind, string][] = [];
      for (const record of bundle.tasks) {
        const { shape, named: inShape } = splitReferences(record.shape);
        this.writer.store.insert({ ...record, shape });
        for (const [kind, ref] of inShape)
          if (!recorded.get(record.id)?.some((reference) => reference.kind === kind))
            named.push([record, kind, ref]);
        this.writer.projects.raiseNextSeq(record.projectId, record.seq + 1);
        this.writer.touch(record.id);
      }
      for (const { taskId, specifications } of bundle.specifications ?? []) {
        if (!incoming.has(taskId)) refuse(`A specification names an unknown task: ${taskId}`);
        this.writer.store.specifications.restore(taskId, specifications);
      }
      // As exported: a recorded relationship keeps who recorded it and the
      // task it resolved to; a shape's name from an older export resolves
      // now, against this record, with who and when unknown.
      for (const [taskId, references] of recorded)
        for (const reference of references) this.writer.references.set(taskId, reference);
      for (const [record, kind, ref] of named)
        this.writer.references.set(record.id, {
          kind,
          ref,
          targetId: this.tasks.resolve(ref)?.id ?? null,
          actor: null,
          recordedAt: null,
        });
      for (const { taskId, session } of bundle.sessions ?? []) {
        if (!incoming.has(taskId)) throw new Error(`Session names an unknown task: ${taskId}`);
        this.writer.conversations.record(taskId, session);
      }
      for (const { taskId, observation } of bundle.sessionObservations ?? []) {
        if (!incoming.has(taskId)) refuse(`A session observation names an unknown task: ${taskId}`);
        const { id, ...facts } = observation;
        this.writer.conversations.observe(taskId, facts, id);
      }

      // A resume binding names its conversation once the conversations are in.
      const exported = new Map(
        (bundle.conversations ?? []).map(({ taskId, conversation }) => [taskId, conversation]),
      );
      for (const record of bundle.tasks)
        if (record.sessionFile)
          this.writer.store.execution.pinConversation(record.id, exported.get(record.id));
      for (const { concerns, ...event } of bundle.events) {
        const id = this.writer.events.insert(event);
        if (concerns?.length) this.writer.events.insertConcerns(id, concerns);
      }
      for (const link of bundle.links) this.writer.links.insert(link);
      for (const ask of bundle.asks) this.writer.asks.insert(ask);
      this.writer.pending.reset = true;
      return {
        projects,
        tasks: bundle.tasks.length,
        events: bundle.events.length,
        links: bundle.links.length,
        asks: bundle.asks.length,
      };
    });
    return run();
  }
}
