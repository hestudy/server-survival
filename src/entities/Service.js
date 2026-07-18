import { SimService } from "../sim/service.js";

// Web-layer service: the simulation core (SimService) owns queueing,
// per-hop routing, maintenance fees, repair settlement and health
// degradation; this subclass adds the Three.js meshes and the visual
// load/health indicators.
class Service extends SimService {
  constructor(type, pos) {
    super(STATE.world, type);
    this.position = pos.clone();

    let geo, mat;
    const materialProps = { roughness: 0.2 };

    switch (type) {
      case "waf":
        geo = new THREE.BoxGeometry(3, 2, 0.5);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.waf,
          ...materialProps,
        });
        break;
      case "alb":
        geo = new THREE.BoxGeometry(3, 1.5, 3);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.alb,
          roughness: 0.1,
        });
        break;
      case "compute":
        geo = new THREE.CylinderGeometry(1.2, 1.2, 3, 16);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.compute,
          ...materialProps,
        });
        break;
      case "db":
        geo = new THREE.CylinderGeometry(2, 2, 2, 6);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.db,
          roughness: 0.3,
        });
        break;
      case "s3":
        geo = new THREE.CylinderGeometry(1.8, 1.5, 1.5, 8);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.s3,
          ...materialProps,
        });
        break;
      case "cache":
        geo = new THREE.BoxGeometry(2.5, 1.5, 2.5);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.cache,
          ...materialProps,
        });
        break;
      case "sqs":
        geo = new THREE.BoxGeometry(4, 0.8, 2);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.sqs,
          ...materialProps,
        });
        break;
      case "cdn":
        geo = new THREE.SphereGeometry(1.5, 16, 16);
        mat = new THREE.MeshStandardMaterial({
          color: 0x4ade80, // Greenish for static
          ...materialProps,
          wireframe: true,
        });
        break;
      case "apigw":
        geo = new THREE.OctahedronGeometry(1.5, 0);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.apigw,
          ...materialProps,
        });
        break;
      case "nosql":
        geo = new THREE.CylinderGeometry(2, 2, 1.5, 16);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.nosql,
          roughness: 0.3,
        });
        break;
      case "search":
        geo = new THREE.DodecahedronGeometry(1.5, 0);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.search,
          ...materialProps,
        });
        break;
      case "replica":
        geo = new THREE.CylinderGeometry(1.8, 1.8, 1, 6);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.replica,
          roughness: 0.3,
        });
        break;
      case "serverless":
        geo = new THREE.TetrahedronGeometry(1.8, 0);
        mat = new THREE.MeshStandardMaterial({
          color: CONFIG.colors.serverless,
          ...materialProps,
        });
        break;
    }

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(pos);

    if (type === "waf") this.mesh.position.y += 1;
    else if (type === "alb") this.mesh.position.y += 0.75;
    else if (type === "compute") this.mesh.position.y += 1.5;
    else if (type === "s3") this.mesh.position.y += 0.75;
    else if (type === "cache") this.mesh.position.y += 0.75;
    else if (type === "sqs") this.mesh.position.y += 0.4;
    else if (type === "cdn") this.mesh.position.y += 1.5;
    else if (type === "apigw") this.mesh.position.y += 1.5;
    else if (type === "nosql") this.mesh.position.y += 1;
    else if (type === "search") this.mesh.position.y += 1.5;
    else if (type === "replica") this.mesh.position.y += 1;
    else if (type === "serverless") this.mesh.position.y += 1.5;
    else this.mesh.position.y += 1;

    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData = { id: this.id };

    const ringGeo = new THREE.RingGeometry(2.5, 2.7, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x333333,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
    });
    this.loadRing = new THREE.Mesh(ringGeo, ringMat);
    this.loadRing.rotation.x = -Math.PI / 2;
    this.loadRing.position.y = -this.mesh.position.y + 0.1;
    this.mesh.add(this.loadRing);

    this.tierRings = [];
    this.originalColor = mat.color.getHex();

    // Health bar (3D bar above service)
    this.createHealthBar();

    // SQS queue fill indicator
    if (type === "sqs") {
      const fillGeo = new THREE.BoxGeometry(3.8, 0.6, 1.8);
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: 0.3,
      });
      this.queueFill = new THREE.Mesh(fillGeo, fillMat);
      this.queueFill.position.set(0, 0, 0);
      this.queueFill.scale.x = 0;
      this.mesh.add(this.queueFill);
    }

    serviceGroup.add(this.mesh);

    // Quality tiers (issue #12): a service placed while the renderer is
    // degraded starts with the simplified material right away.
    window.applyMaterialQuality?.(this.mesh);
  }

  upgrade() {
    if (!["compute", "db", "cache", "apigw", "nosql", "search", "replica"].includes(this.type)) return;
    const tiers = CONFIG.services[this.type].tiers;
    if (this.tier >= tiers.length) return;

    const nextTier = tiers[this.tier];
    if (STATE.money < nextTier.cost) {
      flashMoney();
      return;
    }

    STATE.money -= nextTier.cost;
    // Track upgrade costs in finances
    if (STATE.finances) {
      STATE.finances.expenses.services += nextTier.cost;
      STATE.finances.expenses.byService[this.type] =
        (STATE.finances.expenses.byService[this.type] || 0) + nextTier.cost;
    }
    this.tier++;
    this.config = { ...this.config, capacity: nextTier.capacity };

    // Update cacheHitRate for cache type
    if (this.type === "cache" && nextTier.cacheHitRate) {
      this.config = { ...this.config, cacheHitRate: nextTier.cacheHitRate };
    }

    // Update rateLimit for apigw type
    if (this.type === "apigw" && nextTier.rateLimit) {
      this.config = { ...this.config, rateLimit: nextTier.rateLimit };
    }

    STATE.sound.playPlace();

    // Visuals
    this.addTierRing(this.tier);
  }

  tierRingStyle() {
    if (this.type === "db") return { size: 2.2, color: 0xff0000 };
    if (this.type === "cache") return { size: 1.5, color: 0xdc382d }; // Redis red
    if (this.type === "apigw") return { size: 1.5, color: 0xe879f9 };
    if (this.type === "nosql") return { size: 2.0, color: 0x7c3aed };
    if (this.type === "search") return { size: 1.5, color: 0x06b6d4 };
    if (this.type === "replica") return { size: 1.8, color: 0xf472b6 };
    return { size: 1.3, color: 0xffff00 };
  }

  addTierRing(tierLevel) {
    const { size, color } = this.tierRingStyle();
    const ringGeo = new THREE.TorusGeometry(size, 0.1, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -this.mesh.position.y + (tierLevel === 2 ? 0.5 : 1.0);
    this.mesh.add(ring);
    this.tierRings.push(ring);
  }

  // One ring per tier above 1 — used when rebuilding a saved service.
  drawTierRings() {
    for (let t = 2; t <= this.tier; t++) this.addTierRing(t);
  }

  update(dt) {
    // Health decay/regen numbers live in the sim core (SimService); this
    // layer only repaints the health visuals each frame.
    if (CONFIG.survival.degradation?.enabled && STATE.gameMode === "survival") {
      this.updateHealthVisual();
    }

    // Simulation core: health degradation, maintenance fee, rate window,
    // compute pull, queue admission, routing.
    super.update(dt);

    if (this.totalLoad > 0.8) {
      this.loadRing.material.color.setHex(0xff0000);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.8;
      }
    } else if (this.totalLoad > 0.5) {
      this.loadRing.material.color.setHex(0xffaa00);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.6;
      }
    } else if (this.totalLoad > 0.2) {
      this.loadRing.material.color.setHex(0xffff00);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.4;
      }
    } else {
      this.loadRing.material.color.setHex(0x00ff00);
      if (STATE.selectedNodeId === this.id) {
        this.loadRing.material.opacity = 1.0;
      } else {
        this.loadRing.material.opacity = 0.3;
      }
    }

    if (this.type === "sqs" && this.queueFill) {
      const maxQ = this.config.maxQueueSize || 200;
      const fillPercent = this.queue.length / maxQ;
      this.queueFill.scale.x = fillPercent;
      this.queueFill.position.x = (fillPercent - 1) * 1.9;

      if (fillPercent > 0.8) {
        this.queueFill.material.color.setHex(0xff0000);
      } else if (fillPercent > 0.5) {
        this.queueFill.material.color.setHex(0xffaa00);
      } else {
        this.queueFill.material.color.setHex(0x00ff00);
      }
    }
  }

  flashCacheHit() {
    if (!this.mesh) return;
    const originalColor = this.mesh.material.color.getHex();
    this.mesh.material.color.setHex(0x00ff00); // Green flash
    setTimeout(() => {
      this.mesh.material.color.setHex(originalColor);
    }, 100);
  }

  destroy() {
    serviceGroup.remove(this.mesh);
    if (this.tierRings) {
      this.tierRings.forEach((r) => {
        r.geometry.dispose();
        r.material.dispose();
      });
    }
    if (this.healthBarBg) {
      this.healthBarBg.geometry.dispose();
      this.healthBarBg.material.dispose();
    }
    if (this.healthBarFill) {
      this.healthBarFill.geometry.dispose();
      this.healthBarFill.material.dispose();
    }
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    // The full-quality material parked while a low tier is active
    // (issue #12) needs disposing too.
    if (this.mesh.userData.perfFullMat) {
      this.mesh.userData.perfFullMat.dispose();
      this.mesh.userData.perfFullMat = null;
    }
  }

  createHealthBar() {
    // Background bar (dark)
    const bgGeo = new THREE.BoxGeometry(3, 0.3, 0.1);
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x333333,
      transparent: true,
      opacity: 0.8,
    });
    this.healthBarBg = new THREE.Mesh(bgGeo, bgMat);
    this.healthBarBg.position.set(0, 2.5, 0);
    this.mesh.add(this.healthBarBg);

    // Fill bar (colored based on health)
    const fillGeo = new THREE.BoxGeometry(2.9, 0.25, 0.12);
    const fillMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    this.healthBarFill = new THREE.Mesh(fillGeo, fillMat);
    this.healthBarFill.position.set(0, 0, 0.01);
    this.healthBarBg.add(this.healthBarFill);

    // Initially hidden (show when damaged)
    this.healthBarBg.visible = false;
  }

  updateHealthBar() {
    if (!this.healthBarBg || !this.healthBarFill) return;

    // Show health bar when health < 100
    this.healthBarBg.visible = this.health < 100;

    if (this.health >= 100) return;

    // Update fill scale (0 to 1)
    const fillPercent = this.health / 100;
    this.healthBarFill.scale.x = Math.max(0.01, fillPercent);
    this.healthBarFill.position.x = (fillPercent - 1) * 1.45;

    // Update color based on health
    if (this.health < 30) {
      this.healthBarFill.material.color.setHex(0xff0000); // Red
    } else if (this.health < 60) {
      this.healthBarFill.material.color.setHex(0xff8800); // Orange
    } else if (this.health < 80) {
      this.healthBarFill.material.color.setHex(0xffff00); // Yellow
    } else {
      this.healthBarFill.material.color.setHex(0x00ff00); // Green
    }
  }

  updateHealthVisual() {
    if (!this.mesh || !this.mesh.material) return;

    // Update the 3D health bar
    this.updateHealthBar();

    const criticalHealth = CONFIG.survival.degradation?.criticalHealth || 30;

    if (this.health < criticalHealth) {
      // Critical - red tint and pulsing
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
      this.mesh.material.color.setHex(0xff0000);
      this.mesh.material.emissive = new THREE.Color(0xff0000);
      this.mesh.material.emissiveIntensity = pulse * 0.3;
    } else if (this.health < 60) {
      // Damaged - orange tint
      this.mesh.material.color.setHex(0xff8800);
      this.mesh.material.emissive = new THREE.Color(0x000000);
      this.mesh.material.emissiveIntensity = 0;
    } else if (this.health < 80) {
      // Worn - yellow tint
      const healthRatio = this.health / 100;
      const r =
        (1 - healthRatio) * 255 +
        healthRatio * ((this.originalColor >> 16) & 0xff);
      const g = healthRatio * ((this.originalColor >> 8) & 0xff);
      const b = healthRatio * (this.originalColor & 0xff);
      this.mesh.material.color.setRGB(r / 255, g / 255, b / 255);
      this.mesh.material.emissive = new THREE.Color(0x000000);
      this.mesh.material.emissiveIntensity = 0;
    } else {
      // Healthy - original color
      this.mesh.material.color.setHex(this.originalColor);
      this.mesh.material.emissive = new THREE.Color(0x000000);
      this.mesh.material.emissiveIntensity = 0;
    }
  }

  repair() {
    if (this.health >= 100) return false;

    // Cost math and the money check settle in the sim economy.
    if (!STATE.world.economy.repairService(this)) {
      flashMoney();
      addInterventionWarning(
        i18n.t('repair_need_money', { cost: STATE.world.economy.repairCost(this) }),
        "danger",
        2000
      );
      return false;
    }

    this.updateHealthVisual();
    STATE.sound?.playPlace();
    return true;
  }

}

// Transitional global bridge (ADR-0002 expand step): instantiated by game.js.
window.Service = Service;
