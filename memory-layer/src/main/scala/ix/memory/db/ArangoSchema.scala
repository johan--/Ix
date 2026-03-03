package ix.memory.db

import cats.effect.IO
import com.arangodb.ArangoDatabase
import com.arangodb.entity.CollectionType
import com.arangodb.model.{CollectionCreateOptions, PersistentIndexOptions, TtlIndexOptions}

object ArangoSchema {

  def ensure(db: ArangoDatabase): IO[Unit] = IO.blocking {
    // Vertex collections
    ensureCollection(db, "nodes")
    ensureCollection(db, "claims")
    ensureCollection(db, "conflict_sets")
    ensureCollection(db, "patches")
    ensureCollection(db, "revisions")
    ensureCollection(db, "idempotency_keys")

    // Edge collection
    ensureCollection(db, "edges", edge = true)

    // Indexes — nodes
    val nodes = db.collection("nodes")
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("kind"),
      new PersistentIndexOptions()
    )
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("name"),
      new PersistentIndexOptions().sparse(true)
    )
    nodes.ensurePersistentIndex(
      java.util.Arrays.asList("logical_id"),
      new PersistentIndexOptions()
    )

    // Indexes — edges
    val edges = db.collection("edges")
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("src"),
      new PersistentIndexOptions()
    )
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("dst"),
      new PersistentIndexOptions()
    )
    edges.ensurePersistentIndex(
      java.util.Arrays.asList("predicate"),
      new PersistentIndexOptions()
    )

    // Indexes — claims
    val claims = db.collection("claims")
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("entity_id"),
      new PersistentIndexOptions()
    )
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("status"),
      new PersistentIndexOptions()
    )
    claims.ensurePersistentIndex(
      java.util.Arrays.asList("statement"),
      new PersistentIndexOptions().sparse(true)
    )

    // Indexes — patches
    val patches = db.collection("patches")
    patches.ensurePersistentIndex(
      java.util.Arrays.asList("patch_id"),
      new PersistentIndexOptions().unique(true)
    )
    patches.ensurePersistentIndex(
      java.util.Arrays.asList("data.source.uri", "data.source.extractor"),
      new PersistentIndexOptions()
    )

    // Indexes — idempotency_keys
    val idem = db.collection("idempotency_keys")
    idem.ensurePersistentIndex(
      java.util.Arrays.asList("key"),
      new PersistentIndexOptions().unique(true)
    )
    idem.ensureTtlIndex(
      java.util.Arrays.asList("created_at"),
      new TtlIndexOptions().expireAfter(86400)
    )

    ()
  }

  private def ensureCollection(db: ArangoDatabase, name: String, edge: Boolean = false): Unit = {
    if (!db.collection(name).exists()) {
      if (edge) {
        db.createCollection(name, new CollectionCreateOptions().`type`(CollectionType.EDGES))
      } else {
        db.createCollection(name)
      }
    }
  }
}
