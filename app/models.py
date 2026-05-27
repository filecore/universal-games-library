from datetime import datetime
from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class Game(Base):
    __tablename__ = "games"

    id = Column(Integer, primary_key=True)
    igdb_id = Column(Integer, unique=True, nullable=True, index=True)
    title = Column(String(512), nullable=False, index=True)
    title_normalised = Column(String(512), nullable=False, index=True)
    release_year = Column(Integer, nullable=True)
    player_count_min = Column(Integer, nullable=True)
    player_count_max = Column(Integer, nullable=True)
    has_local_coop = Column(Boolean, default=False)
    has_online_coop = Column(Boolean, default=False)
    has_local_vs = Column(Boolean, default=False)
    has_online_vs = Column(Boolean, default=False)
    has_campaign = Column(Boolean, default=False)
    genres = Column(JSONB, default=list)
    tags = Column(JSONB, default=list)
    cover_url = Column(String(1024), nullable=True)
    igdb_raw = Column(JSONB, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    ownership = relationship(
        "Ownership", back_populates="game", cascade="all,delete-orphan"
    )


class Ownership(Base):
    __tablename__ = "ownership"
    __table_args__ = (
        UniqueConstraint(
            "game_id", "store", "external_id", name="ux_ownership_game_store_ext"
        ),
    )

    id = Column(Integer, primary_key=True)
    game_id = Column(
        Integer,
        ForeignKey("games.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    store = Column(String(32), nullable=False, index=True)
    platform = Column(String(32), nullable=False, index=True)
    external_id = Column(String(128), nullable=True)
    is_physical = Column(Boolean, default=False)
    acquired_at = Column(DateTime, nullable=True)
    playtime_minutes = Column(Integer, nullable=True)
    raw = Column(JSONB, nullable=True)

    game = relationship("Game", back_populates="ownership")


class IngestionRun(Base):
    __tablename__ = "ingestion_runs"

    id = Column(Integer, primary_key=True)
    source = Column(String(64), nullable=False, index=True)
    ran_at = Column(DateTime, default=datetime.utcnow)
    success = Column(Boolean, default=False)
    message = Column(Text, nullable=True)
    next_refresh_due_at = Column(DateTime, nullable=True)
