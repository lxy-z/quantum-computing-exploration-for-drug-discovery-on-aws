import * as path from 'path';
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam'
import * as batch from '@aws-cdk/aws-batch'
import * as ecs from '@aws-cdk/aws-ecs'
import * as sfn from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';

import {
    Construct,
} from '@aws-cdk/core';
import {
    E2BIG
} from 'constants';
import {
    PublicSubnet
} from '@aws-cdk/aws-ec2';

export interface BatchProps {
    bucketName: string;
    region: string;
    account: string;
}


export class QCLifeScienceBatch extends Construct {

    private batchJobExecutionRole: iam.Role;
    private batchJobRole: iam.Role;
    private props: BatchProps;

    private createBatchJobExecutionRole(roleName: string): iam.Role {
        const role = new iam.Role(this, roleName, {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });

        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBraketFullAccess'))
        role.addToPolicy(new iam.PolicyStatement({
            resources: [
                'arn:aws:s3:::amazon-braket-*',
                'arn:aws:s3:::braketnotebookcdk-*',
                'arn:aws:s3:::qcstack*'
            ],
            actions: [
                "s3:GetObject",
                "s3:PutObject",
                "s3:ListBucket"
            ]
        }));

        role.addToPolicy(new iam.PolicyStatement({
            resources: [
                `arn:aws:logs:*:${this.props.account}:log-group:/aws/batch/*`
            ],
            actions: [
                "logs:CreateLogStream",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents",
                "logs:CreateLogGroup"
            ]
        }));

        role.addToPolicy(new iam.PolicyStatement({
            resources: [
                '*'
            ],
            actions: [
                "braket:*",
                "ecr:*",
                "s3:*"
            ]
        }));
        return role
    }

    private createAggResultLambdaRole(): iam.Role {
        const role = new iam.Role(this, 'AggResultLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        });
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonAthenaFullAccess'))
        role.addToPolicy(new iam.PolicyStatement({
            resources: [
                'arn:aws:s3:::amazon-braket-*',
                'arn:aws:s3:::braketnotebookcdk-*',
                'arn:aws:s3:::qcstack*'
            ],
            actions: [
                "s3:GetObject",
                "s3:PutObject",
                "s3:ListBucket"
            ]
        }));
        return role;
    }

    // constructor 
    constructor(scope: Construct, id: string, props: BatchProps) {
        super(scope, id);
        this.props = props;

        this.batchJobExecutionRole = this.createBatchJobExecutionRole('executionRole');
        this.batchJobRole = this.createBatchJobExecutionRole('jobRole');

        const instanceTypes = [
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.LARGE), // 2 vcpus, 4G mem
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE), // 4 vcpus, 8G mem
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE2), // 8 vcpus, 16G mem
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE4), // 16 vcpus, 32G mem
        ];

        const vpc = new ec2.Vpc(this, 'VPC', {
            subnetConfiguration: [
                {
                    cidrMask: 18,
                    name: 'batch',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
                }
            ]
        });

        vpc.addFlowLog("logtoCW", {
            destination: ec2.FlowLogDestination.toCloudWatchLogs(),
            trafficType: ec2.FlowLogTrafficType.ALL
        });

        const batchEnvironment = new batch.ComputeEnvironment(this, 'Batch-Compute-Env', {
            computeResources: {
                type: batch.ComputeResourceType.ON_DEMAND,
                vpc,
                allocationStrategy: batch.AllocationStrategy.BEST_FIT,
                instanceTypes
            }
        });

        const jobQueue = new batch.JobQueue(this, 'JobQueue', {
            computeEnvironments: [{
                computeEnvironment: batchEnvironment,
                order: 1,
            }, ],
        });

        const Advantage_system1 = 'arn:aws:braket:::device/qpu/d-wave/Advantage_system1';
        const vcpuMemList = [
            [2, 2],
            [4, 4],
            [8, 8],
            [16, 16]
        ];

        const jobDefs = vcpuMemList.map(it => {
            return this.createBatchJobDef(`QCJob_vCpus${it[0]}_Mem${it[1]}G`, 1, 4, Advantage_system1, it[0], it[1], this.props.bucketName);
        });

        new cdk.CfnOutput(this, "jobQueue", {
            value: jobQueue.jobQueueName,
            description: "Batch Job Queue Name"
        });

        // step functions
        const mValues = [1, 2, 3, 4, 5];
        const dValues = [4];
        const deviceArns = [
            'arn:aws:braket:::device/qpu/d-wave/DW_2000Q_6',
            'arn:aws:braket:::device/qpu/d-wave/Advantage_system1',
            'arn:aws:braket:::device/qpu/d-wave/Advantage_system4'
        ];
        const taskList = [];

        for (let m of mValues) {
            for (let d of dValues) {
                for (let deviceArn of deviceArns) {
                    const deviceName = deviceArn.split('/').pop();
                    for (let i = 0; i < vcpuMemList.length; i++) {

                        const [vcpu, mem] = vcpuMemList[i];
                        const jobDef = jobDefs[i];
                        const instanceType = this.getInstanceType(vcpu, mem)
                        const jobName = `M${m}-D${d}-${deviceName}-${instanceType}`.replace(".", "_");

                        const batchTask = new tasks.BatchSubmitJob(this, `${jobName}`, {
                            jobDefinitionArn: jobDef.jobDefinitionArn,
                            jobName,
                            jobQueueArn: jobQueue.jobQueueArn,
                            containerOverrides: {
                                command: ['--M', `${m}`, '--D', `${d}`, '--device-arn',
                                    deviceArn, '--aws-region', props.region, '--instance-type', `${instanceType}`,
                                    '--s3-bucket', this.props.bucketName
                                ],
                            },
                            integrationPattern: sfn.IntegrationPattern.RUN_JOB

                        });
                        taskList.push(batchTask);
                    }
                }
            }
        }

        const batchParallel = new sfn.Parallel(this, "QCBatchParallel");

        for (const task of taskList) {
            batchParallel.branch(task)
        }

        const aggResultLambda = new lambda.Function(this, 'AggResultLambda', {
            runtime: lambda.Runtime.NODEJS_12_X,
            code: lambda.Code.fromAsset(path.join(__dirname, './lambda/AthenaTabeLambda/')),
            handler: 'index.handler',
            memorySize: 512,
            timeout: cdk.Duration.seconds(120),
            environment: {
                BUCKET: props.bucketName
            },
            vpc,
            role: this.createAggResultLambdaRole()
        });

        const aggResultStep = new tasks.LambdaInvoke(this, 'Aggregate Result', {
            lambdaFunction: aggResultLambda,
            outputPath: '$.Payload'
        });
        const success = new sfn.Succeed(this, 'Succeed');

        batchParallel.next(aggResultStep).next(success);


        const stateMachine = new sfn.StateMachine(this, 'QCBatchStateMachine', {
            definition: batchParallel,
            timeout: cdk.Duration.hours(2)
        });

        new cdk.CfnOutput(this, "stateMachine", {
            value: stateMachine.stateMachineName,
            description: "State Machine Name"
        });

        new cdk.CfnOutput(this, "stateMachineURL", {
            value: `https://console.aws.amazon.com/states/home?region=${this.props.region}#/statemachines/view/${stateMachine.stateMachineArn}`,
            description: "State Machine URL"
        });
    }

    private createBatchJobDef(defName: string, m: number, d: number, device: string,
        vcpus: number, mem: number, bucketName: string): batch.JobDefinition {
        const instanceType = this.getInstanceType(vcpus, mem)
        return new batch.JobDefinition(this, defName, {
            platformCapabilities: [batch.PlatformCapabilities.EC2],
            container: {
                image: ecs.ContainerImage.fromAsset(path.join(__dirname, './docker')),
                command: ['--M', `${m}`, '--D', `${d}`, '--device-arn',
                    device, '--aws-region', this.props.region, '--instance-type', `${instanceType}`,
                    '--s3-bucket', bucketName
                ],
                executionRole: this.batchJobExecutionRole,
                jobRole: this.batchJobRole,
                vcpus,
                memoryLimitMiB: mem * 1024,
                privileged: false
            },
            timeout: cdk.Duration.hours(2),
            retryAttempts: 1
        });
    }

    private getInstanceType(vcpus: number, mem: number): string {
        return `vCpus${vcpus}_Mem_${mem}G`;
    }
}