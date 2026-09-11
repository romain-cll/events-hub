import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { RetentionService } from './retention.service';

/**
 * La rétention : un seul service, et l'horloge qui le déclenche.
 *
 * `ScheduleModule.forRoot()` est monté **ici** et non dans `AppModule` parce que
 * la racine de composition n'a aujourd'hui aucune autre raison de connaître un
 * planificateur — l'y poser ferait croire que plusieurs modules en dépendent. À
 * remonter le jour où un second module planifié apparaît : `forRoot()` deux fois
 * enregistrerait deux fois les mêmes tâches.
 *
 * `DatabaseModule` est `@Global()` : rien à importer pour obtenir le pool.
 *
 * Le service est exporté pour que les suites e2e puissent appeler `purge()`
 * explicitement — elles le font pour ne pas dépendre d'une horloge, et c'est
 * aussi la seule façon d'observer un travail qui ne laisse aucune trace HTTP.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
