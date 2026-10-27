//! 动作的物品前提与产出：随身物品够不够、用掉哪几件，完成时得到的新物品和在原地建起的道具。
//! 规则在这里，什么时候结算由 physiology/commands.rs 的道具动作完成决定。
use super::{Action, Definition, Instance, InstantEffect, Placement, Requirement};
use crate::error::{KernelError, Result};
use crate::{inventory::Inventory, World};
use protocol::ItemLocation;
use sha2::{Digest, Sha256};

/// 道具实例引用的定义编号（去掉 @版本）。
fn definition_id(reference: &str) -> &str {
    reference.split('@').next().unwrap_or(reference)
}

impl World {
    /// 本人背包里属于某个物品定义的道具，按编号排序。
    fn carried_of(&self, actor: &str, item: &str) -> Vec<String> {
        let mut ids: Vec<_> = self
            .topo
            .props()
            .iter()
            .filter(|p| {
                !p.withdrawn
                    && self.inventory.carried_by(&p.id, actor)
                    && p.definition.as_deref().map(definition_id) == Some(item)
            })
            .map(|p| p.id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// 物品前提：每一项都要随身带够。开始、进行中和完成时都查。
    pub(crate) fn check_requirements(&self, actor: &str, action: &Action) -> Result<()> {
        for r in &action.requires {
            let have = self.carried_of(actor, &r.item).len() as u32;
            ensure!(
                have >= r.count,
                KernelError::action(format!(
                    "需要随身带着{}×{}，现在只有 {have} 件",
                    r.name, r.count
                ))
            );
        }
        Ok(())
    }

    /// 用掉标了 consume 的前提物品；返回回执里的变化。
    pub(crate) fn use_up_requirements(&mut self, actor: &str, action: &Action) -> Vec<String> {
        let mut changes = Vec::new();
        for r in action.requires.iter().filter(|r| r.consume) {
            for id in self
                .carried_of(actor, &r.item)
                .into_iter()
                .take(r.count as usize)
            {
                self.consume_carried_prop(&id);
            }
            changes.push(format!("用掉{}×{}", r.name, r.count));
        }
        changes
    }

    /// 本次完成要产出的物品放得下：背包格数和世界道具总数都查，失败时什么都还没改。
    pub(crate) fn check_made_items(
        &self,
        actor: &str,
        effects: &[InstantEffect],
        key: &str,
    ) -> Result<()> {
        let mut incoming = Vec::new();
        for (n, e) in effects.iter().enumerate() {
            if let InstantEffect::GiveItem { item, count } = e {
                for p in self.made_items(actor, item, *count, &format!("{key}/{n}")) {
                    incoming.push(super::catalog::resolve(&p.instance, &p.definition)?);
                }
            }
        }
        if incoming.is_empty() {
            return Ok(());
        }
        let carried = self
            .topo
            .props()
            .iter()
            .filter(|p| !p.withdrawn && self.inventory.carried_by(&p.id, actor));
        ensure!(
            Inventory::slots_used(&self.props, carried.chain(incoming.iter()))
                <= crate::inventory::CAPACITY,
            KernelError::inventory("背包满了，放不下新得到的东西")
        );
        super::check_room(self.topo.props().len(), incoming.len())
    }

    /// 完成时产出：先在原地建道具（找不到位置会失败），再把物品放进背包。返回回执里的变化。
    pub(crate) fn make_things(
        &mut self,
        actor: &str,
        effects: &[InstantEffect],
        key: &str,
    ) -> Result<Vec<String>> {
        let mut changes = Vec::new();
        for (n, e) in effects.iter().enumerate() {
            if let InstantEffect::PlaceProp { prop } = e {
                let locale = self.actors[actor].locus.locale.clone();
                let placement = Placement {
                    instance: Instance {
                        id: made_id(&format!("{actor}/{key}/{n}"), 0),
                        definition: prop.reference(),
                        locale: locale.clone(),
                        name: None,
                        board: None,
                    },
                    definition: prop.as_ref().clone(),
                };
                self.place_prop(placement)?;
                changes.push(format!(
                    "在{}建成「{}」",
                    self.topo.locale_name(&locale),
                    prop.name
                ));
            }
        }
        for (n, e) in effects.iter().enumerate() {
            if let InstantEffect::GiveItem { item, count } = e {
                for p in self.made_items(actor, item, *count, &format!("{key}/{n}")) {
                    let prop = self.props.validate_placement(&self.topo, &p)?;
                    let id = p.instance.id.clone();
                    self.props.insert(&mut self.topo, p, prop);
                    self.inventory.set_location(
                        &mut self.topo,
                        &mut self.props,
                        &id,
                        ItemLocation::Carried {
                            actor: actor.into(),
                        },
                    );
                }
                changes.push(format!("得到{}×{count}", item.name));
            }
        }
        if !changes.is_empty() {
            // 道具列表和可供性都要重发；当前动作的可供性还在，回执照常能读。
            self.inventory.bump();
            self.affordances.rebuild(&self.topo);
            self.topo.bump_navigation_revision();
        }
        Ok(changes)
    }

    fn made_items(&self, actor: &str, item: &Definition, count: u32, key: &str) -> Vec<Placement> {
        let seed = format!("{actor}/{key}");
        (0..count)
            .map(|i| Placement {
                instance: Instance {
                    id: made_id(&seed, i),
                    definition: item.reference(),
                    locale: self.actors[actor].locus.locale.clone(),
                    name: None,
                    board: None,
                },
                definition: item.clone(),
            })
            .collect()
    }
}

/// 产出实例的编号：由本人、动作和完成时刻派生，同一次完成里按序号区分。
fn made_id(seed: &str, i: u32) -> String {
    format!("made:{:x}_{i}", Sha256::digest(seed))
}

/// 前提的说明（观察与道具目录用）。
pub(crate) fn requirement_text(r: &Requirement) -> String {
    format!(
        "随身带着{}×{}{}",
        r.name,
        r.count,
        if r.consume {
            "（完成时用掉）"
        } else {
            "（不消耗）"
        }
    )
}
