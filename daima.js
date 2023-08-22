skill={
    trigger:{
        player:"phaseZhunbeiBegin",
    },
    forced:true,
    filter:function(event,player){
        return player.countEquipableSlot(1)>0;
    },
    content:function(){
        'step 0'
        if(!_status.characterlist){
            lib.skill.pingjian.initList();
        }
        var list=_status.characterlist.randomGets(5);
        if(!list.length) event.finish();
        else{
            var num=player.countEquipableSlot(1);
            player.chooseButton([
                '挈挟：选择至多'+get.cnNumber(num)+'张武将置入武器栏',
                [list,'character'],
            ],[1,num],true).set('ai',function(button){
                var name=button.link;
                var info=lib.character[name];
                var skills=info[3].filter(function(skill){
                    var info=get.skillInfoTranslation(skill);
                    if(!info.includes('【杀】')) return false;
                    var list=get.skillCategoriesOf(skill);
                    list.remove('锁定技');
                    return list.length==0;
                });
                var eff=0.2;
                for(var i of skills){
                    eff+=get.skillRank(i,'in');
                }
                return eff;
            })
        }
        'step 1'
        if(result.bool){
            var list=result.links;
            game.addVideo('skill',player,['qiexie',[list]])
            game.broadcastAll(function(list){
                for(var name of list) lib.skill.qiexie.createCard(name);
            },list);
            var cards=list.map(function(name){
                var card=game.createCard('qiexie_'+name,'none',get.infoMaxHp(lib.character[name][2]));
                return card;
            });
            player.addTempSkill('qiexie_blocker','qiexieAfter');
            player.markAuto('qiexie_blocker',cards);
            player.$gain2(cards);
            game.delayx();
            for(var card of cards) player.equip(card);
        }
    },
    video:function(player,info){
        for(var name of info[0]){
            lib.skill.qiexie.createCard(name);
        }
    },
    createCard:function(name){
        if(!_status.postReconnect.qiexie) _status.postReconnect.qiexie=[
            function(list){
                for(var name of list) lib.skill.qiexie.createCard(name);
            },[]
        ];
        _status.postReconnect.qiexie[1].add(name)
        if(!lib.card['qiexie_'+name]){
            if(lib.translate[name+'_ab']) lib.translate['qiexie_'+name]=lib.translate[name+'_ab'];
            else lib.translate['qiexie_'+name]=lib.translate[name];
            var info=lib.character[name];
            var card={
                fullimage:true,
                image:'character:'+name,
                type:'equip',
                subtype:'equip1',
                enable:true,
                selectTarget:-1,
                filterCard:function(card,player,target){
                    if(player!=target) return false;
                    return target.canEquip(card,true);
                },
                modTarget:true,
                allowMultiple:false,
                content:lib.element.content.equipCard,
                toself:true,
                ai:{},
                skills:['qiexie_destroy'],
            }
            var maxHp=get.infoMaxHp(info[2]);
            if(maxHp!=1) card.distance={attackFrom:(1-maxHp)};
            var skills=info[3].filter(function(skill){
                var info=get.skillInfoTranslation(skill);
                if(!info.includes('【杀】')) return false;
                var list=get.skillCategoriesOf(skill);
                list.remove('锁定技');
                return list.length==0;
            });
            var str='锁定技。';
            if(skills.length){
                card.skills.addArray(skills);
                str+='你视为拥有技能';
                for(var skill of skills){
                    str+='〖'+get.translation(skill)+'〗';
                    str+='、';
                }
                str=str.slice(0,str.length-1);
                str+='；'
            }
            str+='此牌离开你的装备区后，改为置入剩余武将牌牌堆。';
            lib.translate['qiexie_'+name+'_info']=str;
            lib.card['qiexie_'+name]=card;
        }
    },
    subSkill:{
        blocker:{
            mod:{
                canBeReplaced:function(card,player){
                    if(player.getStorage('qiexie_blocker').contains(card)) return false;
                },
            },
            charlotte:true,
            onremove:true,
            trigger:{
                player:"equipEnd",
            },
            forced:true,
            firstDo:true,
            priority:null,
            filter:function(event){
                var evt=event.getParent();
                if(evt.name!='qiexie') return false;
                return !evt.next.some(event=>{
                    return event.name=='equip';
                })
            },
            content:function(){
                player.removeSkill('qiexie_blocker');
            },
            sub:true,
        },
        destroy:{
            trigger:{
                player:"loseBegin",
            },
            equipSkill:true,
            forceDie:true,
            charlotte:true,
            forced:true,
            popup:false,
            filter:function(event,player){
                return event.cards.some(card=>card.name.indexOf('qiexie_')==0)
            },
            content:function(){
                for(var card of trigger.cards){
                    if(card.name.indexOf('qiexie_')==0){
                        card._destroy=true;
                        game.log(card,'被放回武将牌堆');
                        var name=card.name.slice(7);
                        if(lib.character[name]) _status.characterlist.add(name);
                    }
                }
            },
            sub:true,
        },
    },
}